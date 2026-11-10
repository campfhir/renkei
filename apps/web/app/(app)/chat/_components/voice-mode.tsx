'use client';

/**
 * The immersive voice conversation: the chat, with the microphone as the
 * composer and the speaker as the message list. Opens over the thread,
 * listens through lib/voice/recorder.ts, sends each utterance as a turn
 * exactly as typing it would (so it lands in the same chat, with the same
 * tools, model and project), and reads the reply as it streams. The
 * recognition starts at the utterance's first real pause, before the
 * recorder has decided it is over, so the words are usually back by then
 * and the turn goes out the moment it is. It is asked in the set language
 * first, from the endpoint that answers fastest; when the person may be
 * speaking another, which language it was is asked behind that, and a
 * different answer corrects what was sent (see Recognition).
 *
 * Interruptions are the point, and so is not interrupting on a cough.
 * The rules are lib/voice/barge-in.ts's, and the recognizer is the
 * judge, not the microphone's loudness: once the person has made enough
 * sound over a reply being read aloud, that sound is transcribed, and
 * only if it reads as words — not a cough, not a "mm-hm", not the
 * reply's own echo — does the voice stop and the turn get cancelled,
 * what they said being sent once they pause; while a reply is still
 * being worked out — the model thinking, a tool call running, nothing
 * of the answer read yet — talking cancels nothing, and what is said
 * queues as the next message, sent when the reply is done; and a sound
 * under the voice that never became words is dropped, not sent. The
 * thread underneath keeps every message, so leaving voice mode leaves a
 * chat that reads exactly like the conversation went.
 *
 * With the walkie-talkie preference (`pushToTalk`) the microphone waits
 * for a press instead of a voice: Talk opens the microphone and the
 * recording, Done closes and sends it, and a ten-second silence closes
 * it unasked. Pressing Talk over a reply interrupts it the way speaking
 * over it does.
 *
 * When the microphone is open is what decides how a Bluetooth headset
 * sounds: any open microphone puts it on its hands-free profile, mono
 * and narrow, for as long as the track lives. So the microphone is only
 * open when it can be used. Press-to-talk closes it between takes. With
 * echo cancellation off — the setting for exactly such a headset — it is
 * closed while the assistant thinks and speaks and opened again the
 * moment the assistant is done, and Stop is the way to have it back
 * sooner. Only with echo cancellation on, where talking over a reply is
 * how it is interrupted, does it stay open throughout.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Icon, ICONS } from '@/components/icons';
import type { ToolPermissionDecision } from '@/lib/chat/views';
import { spokenAsk } from '@/lib/voice/activity';
import {
  beginUtterance,
  holdUtterance,
  holdWorthJudging,
  type AssistantState,
  type Utterance,
} from '@/lib/voice/barge-in';
import { localeLabel } from '@/lib/voice/catalog';
import { UtteranceRecorder } from '@/lib/voice/recorder';
import { LIVE_REPLY_OWNER } from '@/lib/voice/use-reply-speech';
import { voiceClient } from '@/lib/voice/client';
import type { SpeechQueue, SpeechQueueState } from '@/lib/voice/speech-queue';
import { speakableText } from '@/lib/voice/speech-text';
import { LevelEmitter } from '@/lib/voice/levels';
import VoiceWave, { type WaveAccent, type WaveTone } from './voice-wave';
import type { PermissionPrompt } from './message-list';
import {
  ASK_AGAIN,
  announceActivity,
  askNarration,
  correctionFor,
  decisionNarration,
  hintOf,
  initialVoiceMode,
  isResponding,
  keyAction,
  labelOf,
  microphoneWhileBusy,
  phaseOf,
  queuedLine,
  recorderMuted,
  replyExcerpt,
  routeUtterance,
  stillWorkingDue,
  takePress,
  talkEnabled,
  toneOf,
  voiceModeReducer,
  workingLine,
  type VoiceActivity,
} from './voice-mode.model';

export type { VoiceActivity } from './voice-mode.model';

/**
 * What a sent utterance can later be corrected by: the message it became,
 * or its place in the thread's queue while a reply was still running.
 */
export type VoiceSendTicket = { message: string } | { queued: number };

/**
 * The recognizer's two answers to an utterance. `quick` is the words in
 * the set language, from the endpoint that answers fastest — what is
 * sent. `detection`, when the person may be speaking another language,
 * is the slower answer that says which language it was, and the words
 * in it: it arrives behind the first and, when the language differs,
 * corrects what was sent (the recorder in one language hears another as
 * noise). Null when the language is not in question.
 */
interface Recognition {
  quick: ReturnType<typeof voiceClient.transcribe>;
  detection: ReturnType<typeof voiceClient.transcribe> | null;
}

/**
 * The session's rules — phases, labels, what an utterance becomes, when a
 * correction applies, when the microphone is released — are
 * voice-mode.model.ts's; this component holds the recorder, the
 * recognizer's calls, the speaker and the timers, and dispatches what
 * they report.
 */
export default function VoiceMode({
  locale,
  detectLanguage,
  onHeard,
  queue,
  queueState,
  running,
  replyText,
  accent,
  userAccent,
  echoCancellation,
  microphone,
  pushToTalk,
  activity,
  thinking,
  permission,
  queued,
  onSend,
  onCorrect,
  onInterrupt,
  onClose,
}: {
  /** The language to listen for — or, when detecting, the one to fall back to. */
  locale: string;
  /** Hear which language each utterance is in, rather than assume `locale`. */
  detectLanguage: boolean;
  /** The language an utterance was heard in, so the reply can be spoken in it. */
  onHeard: (locale: string) => void;
  queue: SpeechQueue;
  /** The assistant's wave colour, this person's preference. */
  accent: WaveAccent;
  /** The person's own wave colour while they are the one being heard. */
  userAccent: WaveAccent;
  /**
   * This device's echo-cancellation choice. Off, the microphone is closed
   * to speech while the assistant talks — its own voice would otherwise
   * interrupt it — and Stop is how a reply is cut short.
   */
  echoCancellation: boolean;
  /** This device's chosen microphone, or null for the default. */
  microphone: string | null;
  /** Walkie-talkie: Talk starts a recording and Done ends it; nothing starts on its own. */
  pushToTalk: boolean;
  queueState: SpeechQueueState;
  /** A turn is in flight (a reply is being written). */
  running: boolean;
  /** The latest reply's Markdown, for the transcript panel. */
  replyText: string;
  /** Tool calls running right now, oldest first; announced as they start. */
  activity: VoiceActivity[];
  /** The model is thinking, with nothing said yet. */
  thinking: boolean;
  /** The ask the running turn is parked behind, if any: shown, spoken, and answerable by voice. */
  permission: PermissionPrompt | null;
  /** Messages waiting behind the running reply (the thread's queue), sent when it is done. */
  queued: number;
  /** Send an utterance as a message; null when it could not be sent. */
  onSend: (text: string) => Promise<VoiceSendTicket | null>;
  /**
   * The utterance was heard in another language, and these are its
   * words: replace what was sent — the queued text, or the message
   * itself, resent with every reply after it removed.
   */
  onCorrect: (ticket: VoiceSendTicket, text: string) => void;
  /** Stop the reply: silence the voice and cancel the turn. */
  onInterrupt: () => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(voiceModeReducer, initialVoiceMode);
  const phase = phaseOf(state, { queueState, running });
  // The microphone's loudness reaches the wave by subscription, never
  // through state: a render per reading would redraw the whole overlay.
  const micLevels = useRef(new LevelEmitter());
  const recorder = useRef<UtteranceRecorder | null>(null);
  // The recognition started at the utterance's pause (recorder.ts's
  // onSpeechPause), for the close to take rather than start its own —
  // numbered with the utterance it is of, so a stale one is never taken.
  const early = useRef<{ seq: number; result: Recognition } | null>(null);
  // The last utterance sent, so a language correction arriving after a
  // newer one went out corrects nothing: resending the older would drop
  // the newer.
  const lastSentSeq = useRef<number | null>(null);
  const spokenReply = replyText ? speakableText(replyText) : '';
  const responding = isResponding({ queueState, spokenReply, activityCount: activity.length });
  // The latest values, for callbacks the recorder holds across renders.
  const latest = useRef({
    queueState,
    responding,
    spokenReply,
    onInterrupt,
    onSend,
    onCorrect,
    onHeard,
    permission,
    announced: state.announced,
  });
  latest.current = {
    queueState,
    responding,
    spokenReply,
    onInterrupt,
    onSend,
    onCorrect,
    onHeard,
    permission,
    announced: state.announced,
  };
  const assistantState = (): AssistantState => ({
    responding: latest.current.responding,
    asking: latest.current.permission !== null,
  });
  // The utterance being heard, from its first sound: what it started over,
  // and whether it cut the reply. Numbered, so a judgement of its sound
  // that comes back after it has closed is left to the close.
  const utterance = useRef<Utterance>(beginUtterance({ responding: false, asking: false }));
  const utteranceSeq = useRef(0);
  // When the voice last had something to say, for the dead-air check.
  const lastVoiceAt = useRef(Date.now());

  /**
   * Say something in the reply's own stream, so it lands in order with
   * the text around it. Only while that stream is open: after a Stop the
   * person asked for silence, and a narration would break it.
   */
  const narrate = useCallback(
    (text: string) => {
      if (queue.owner !== LIVE_REPLY_OWNER) return;
      queue.enqueue(text);
      lastVoiceAt.current = Date.now();
    },
    [queue]
  );

  /** Answer the ask; said back so the person knows it was heard. */
  const decide = useCallback(
    async (decision: ToolPermissionDecision) => {
      const ask = latest.current.permission;
      if (!ask || !ask.canDecide) return;
      dispatch({ type: 'deciding', decision });
      const failure = await ask.onDecide(ask.pending.toolUseId, decision);
      dispatch({ type: 'decided', failure });
      if (!failure) narrate(decisionNarration(decision));
    },
    [narrate]
  );

  useEffect(() => {
    // Ask at once in the set language; with the language in question,
    // ask which it was as well, behind that (see Recognition).
    const recognise = (wav: ArrayBuffer): Recognition => ({
      quick: voiceClient.transcribe(wav, { locale, detectLanguage: false }),
      detection: detectLanguage
        ? voiceClient.transcribe(wav, { locale, detectLanguage: true })
        : null,
    });
    const instance = new UtteranceRecorder({
      echoCancellation,
      deviceId: microphone,
      mode: pushToTalk ? 'manual' : 'auto',
      onSpeechStart: () => {
        // A take was interrupted by the press that opened it (toggleTake).
        if (pushToTalk) {
          dispatch({ type: 'take-started' });
          return;
        }
        // A sound. Nothing is cut yet: a cough is not an interruption.
        utteranceSeq.current += 1;
        utterance.current = beginUtterance(assistantState());
      },
      onSpeechHeld: (wav) => {
        // Enough sound to judge (lib/voice/barge-in.ts): only over a reply
        // being read is the sound so far sent to be recognised, and words
        // silence the reply and drop the turn.
        if (pushToTalk || !holdWorthJudging(assistantState())) return;
        const current = utterance.current;
        const seq = utteranceSeq.current;
        void (async () => {
          // Words or not is the question, in whichever language: the
          // quick answer is enough.
          const result = await voiceClient.transcribe(wav, {
            locale,
            detectLanguage: false,
          });
          // Closed meanwhile: the close judges the whole of it instead.
          if (seq !== utteranceSeq.current || result.error) return;
          const heard = result.data?.text ?? '';
          if (holdUtterance(current, assistantState(), heard, latest.current.spokenReply)) {
            latest.current.onInterrupt();
          }
        })();
      },
      onSpeechPause: (wav) => {
        // Likely the end of the utterance, with the close most of a
        // second away: recognise what there is now, so the words are
        // back by the time the close asks for them. Speech after this
        // makes it stale, and the close (told so) recognises afresh.
        if (pushToTalk) return;
        early.current = { seq: utteranceSeq.current, result: recognise(wav) };
      },
      onUtterance: (wav, _durationMs, sameAsPause) => {
        const closed = utterance.current;
        const seq = utteranceSeq.current;
        utteranceSeq.current += 1;
        const pending =
          sameAsPause && early.current?.seq === seq ? early.current.result : recognise(wav);
        early.current = null;
        void (async () => {
          dispatch({ type: 'transcribing' });
          const result = await pending.quick;
          dispatch({ type: 'transcribed' });
          if (result.error) {
            dispatch({ type: 'recognition-failed', message: result.error });
            return;
          }
          const text = result.data?.text.trim() ?? '';
          const route = routeUtterance({
            text,
            pushToTalk,
            closed,
            assistant: assistantState(),
            spokenReply: latest.current.spokenReply,
          });
          if (route.kind === 'drop') return;
          if (route.interrupt) latest.current.onInterrupt();
          const heardIn = result.data?.locale ?? null;
          dispatch({ type: 'utterance-heard', text, heardIn, locale });
          if (heardIn) latest.current.onHeard(heardIn);
          if (route.kind === 'answer') {
            if (route.decision) await decide(route.decision);
            else narrate(ASK_AGAIN);
            return;
          }
          dispatch({ type: 'sending' });
          let ticket: VoiceSendTicket | null = null;
          try {
            ticket = await latest.current.onSend(text);
          } finally {
            dispatch({ type: 'sent', ok: ticket !== null });
          }
          if (!ticket) return;
          lastSentSeq.current = seq;
          if (!pending.detection) return;
          const detected = await pending.detection;
          const outcome = correctionFor({
            detectedIn: detected.data?.locale ?? null,
            text: detected.data?.text ?? '',
            locale,
            seq,
            lastSentSeq: lastSentSeq.current,
          });
          if (outcome.kind === 'none') return;
          latest.current.onHeard(outcome.locale);
          if (outcome.kind !== 'correct') return;
          dispatch({ type: 'corrected', text: outcome.text, locale: outcome.locale });
          latest.current.onCorrect(ticket, outcome.text);
        })();
      },
      onSpeechEnd: () => {
        dispatch({ type: 'take-ended' });
        // Push-to-talk: the microphone is only open for the take.
        if (pushToTalk) {
          instance.stop();
          micLevels.current.emit(0);
        }
      },
      onLevel: (next) => micLevels.current.emit(next),
      onError: (message) => {
        // Without a microphone there is no voice mode — unless it is only
        // wanted per take, when the next Talk can try again.
        dispatch({ type: 'microphone-failed', message, pushToTalk });
      },
    });
    recorder.current = instance;
    if (pushToTalk) {
      dispatch({ type: 'microphone-ready' });
    } else {
      void instance.start().then((ok) => {
        if (ok) dispatch({ type: 'microphone-ready' });
      });
    }
    return () => {
      instance.stop();
      recorder.current = null;
      early.current = null;
      dispatch({ type: 'recorder-reset' });
    };
    // decide and narrate are stable for the queue's lifetime.
  }, [locale, detectLanguage, echoCancellation, microphone, pushToTalk]);

  // The line under the wave says what is being done right now, and a
  // call the model did not introduce is announced as it starts.
  useEffect(() => {
    const { narration } = announceActivity(latest.current.announced, activity);
    dispatch({ type: 'activity-changed', activity });
    if (narration) narrate(narration);
  }, [activity, narrate]);
  useEffect(() => {
    if (!running) dispatch({ type: 'turn-finished' });
  }, [running]);

  // A long quiet while the reply is worked out gets a word, so a slow
  // answer is not mistaken for a dropped one.
  useEffect(() => {
    if (queueState === 'speaking') lastVoiceAt.current = Date.now();
  }, [queueState]);
  useEffect(() => {
    if (!running || permission) return;
    const timer = setInterval(() => {
      if (!stillWorkingDue(latest.current.queueState, lastVoiceAt.current, Date.now())) return;
      narrate('Still working on it.');
    }, 5_000);
    return () => clearInterval(timer);
  }, [running, permission, narrate]);

  // The ask, spoken the moment it is raised.
  const askId = permission?.pending.toolUseId ?? null;
  useEffect(() => {
    if (!askId || !permission) return;
    dispatch({ type: 'ask-raised' });
    narrate(askNarration(permission.pending.name));
    // Spoken once per ask, not on every re-render carrying it.
  }, [askId, narrate]);

  // Without echo cancellation the microphone is released while the
  // assistant works, so a headset can play the reply in stereo. Stop
  // makes "after" now.
  const busy = running || queueState !== 'idle';
  useEffect(() => {
    const instance = recorder.current;
    if (!instance) return;
    const action = microphoneWhileBusy({
      pushToTalk,
      echoCancellation,
      phase,
      busy,
      active: instance.active,
    });
    if (action === 'stop') {
      instance.stop();
      micLevels.current.emit(0);
    } else if (action === 'start') {
      void instance.start();
    }
  }, [pushToTalk, echoCancellation, busy, phase]);

  // The speaker stays open for the whole conversation, so a reply's first
  // word is not lost to a headset waking up (lib/voice/speech-queue.ts).
  useEffect(() => queue.hold(), [queue]);

  // The speaker's own voice must not read as the person talking: with
  // echo cancellation, a higher bar while it speaks; without, no
  // listening at all until it has finished.
  useEffect(() => {
    recorder.current?.holdWhileSpeaking(queueState === 'speaking');
  }, [queueState]);
  const muteRecorder = recorderMuted({
    muted: state.muted,
    pushToTalk,
    echoCancellation,
    queueState,
  });
  useEffect(() => {
    recorder.current?.setMuted(muteRecorder);
  }, [muteRecorder]);

  const close = useCallback(() => {
    recorder.current?.stop();
    queue.stop();
    onClose();
  }, [queue, onClose]);

  /** Push-to-talk's Talk/Done (voice-mode.model.ts's takePress). */
  const opening = state.opening;
  const toggleTake = useCallback(() => {
    const instance = recorder.current;
    if (!instance) return;
    const press = takePress({
      opening,
      taking: instance.taking,
      responding: latest.current.responding,
      asking: latest.current.permission !== null,
    });
    if (!press) return;
    if (press.kind === 'end') {
      instance.endTake();
      return;
    }
    if (press.interrupt) latest.current.onInterrupt();
    dispatch({ type: 'take-opening' });
    void instance.start().then((ok) => {
      dispatch({ type: 'take-opened' });
      if (ok && recorder.current === instance) instance.beginTake();
    });
  }, [opening]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = keyAction({
        key: event.key,
        pushToTalk,
        phase,
        onControl:
          event.target instanceof Element &&
          event.target.closest('button, input, select, textarea, a') !== null,
      });
      if (action === 'close') close();
      if (action === 'take') {
        event.preventDefault();
        toggleTake();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, pushToTalk, phase, toggleTake]);

  const { muted, recording, deciding, decisionError, error, transcript, heard } = state;
  const asking = permission !== null;
  const label = labelOf(phase, state, { pushToTalk, echoCancellation, asking });
  const tone: WaveTone = toneOf(phase, muted, pushToTalk);
  // Whose sound the wave follows: the speaker's, the microphone's, or none.
  const waveLevels = tone === 'speaking' ? queue : tone === 'listening' ? micLevels.current : null;
  const working = workingLine({
    running,
    asking,
    phase,
    activityLine: state.activityLine,
    thinking,
  });
  // What waits behind this reply, said once so the person knows they were heard.
  const queuedNote = queuedLine(queued, busy);
  const hint = hintOf({ phase, transcript, spokenReply, pushToTalk });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation"
      className="fixed inset-0 z-50 flex flex-col bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-800">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Icon path={ICONS.microphone} className="h-4 w-4 text-gray-500" />
          Voice conversation
        </span>
        <button
          type="button"
          onClick={close}
          aria-label="Leave voice mode"
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
        >
          <Icon path={ICONS.close} className="h-5 w-5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
        {/* The wave wears the assistant's colour when it is the assistant's
            turn — writing or speaking — and the person's while they are
            the one being heard, so the two are never confused. */}
        <VoiceWave
          levels={waveLevels}
          tone={tone}
          accent={tone === 'listening' || tone === 'idle' ? userAccent : accent}
          width={360}
          height={180}
        />
        <p className="text-base font-medium" aria-live="polite">
          {label}
        </p>
        {working ? (
          <p className="-mt-4 text-sm text-gray-500" aria-live="polite">
            {working}
          </p>
        ) : null}
        {queuedNote ? (
          <p className="-mt-4 text-sm text-gray-500" aria-live="polite" data-voice-queued>
            {queuedNote}
          </p>
        ) : null}
        {permission ? (
          <div
            role="group"
            aria-label="Permission needed"
            className="w-full max-w-md rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
          >
            <p className="font-medium text-gray-900 dark:text-gray-100">
              The assistant wants to {spokenAsk(permission.pending.name)}.
            </p>
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
              This changes something outside the conversation. Say your answer, or press one.
            </p>
            {permission.canDecide ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={deciding !== null}
                  onClick={() => void decide('once')}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {deciding === 'once' ? 'Allowing…' : 'Allow once'}
                </button>
                <button
                  type="button"
                  disabled={deciding !== null}
                  onClick={() => void decide('always')}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  {deciding === 'always' ? 'Allowing…' : 'Always allow'}
                </button>
                <button
                  type="button"
                  disabled={deciding !== null}
                  onClick={() => void decide('deny')}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  {deciding === 'deny' ? 'Denying…' : 'Deny'}
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-gray-500">
                Only the chat's owner can allow or deny it.
              </p>
            )}
            {decisionError ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
                {decisionError}
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="max-w-md text-center text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}

        <div className="w-full max-w-xl space-y-3 text-sm">
          {transcript ? (
            <div className="flex flex-col items-end gap-0.5">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-white">
                {transcript}
              </p>
              {heard ? (
                <span className="text-xs text-gray-500">
                  Heard in {localeLabel(heard)} — the reply is read in it too.
                </span>
              ) : null}
            </div>
          ) : null}
          {spokenReply ? (
            <p className="max-h-40 overflow-y-auto rounded-2xl rounded-bl-sm bg-gray-100 px-4 py-2 text-gray-800 dark:bg-gray-900 dark:text-gray-200">
              {replyExcerpt(spokenReply)}
            </p>
          ) : null}
          {hint ? <p className="text-center text-gray-500">{hint}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-3 border-t border-gray-200 px-4 py-4 dark:border-gray-800">
        {pushToTalk ? (
          <button
            type="button"
            onClick={toggleTake}
            disabled={!talkEnabled(phase, opening)}
            aria-pressed={recording}
            aria-keyshortcuts="Space"
            title={recording ? 'Stop recording and send (Space)' : 'Start recording (Space)'}
            className={`flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium disabled:opacity-40 ${
              recording
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            <Icon path={recording ? ICONS.check : ICONS.microphone} className="h-4 w-4" />
            {recording ? 'Done' : 'Talk'}
          </button>
        ) : null}
        {pushToTalk ? null : (
          <button
            type="button"
            onClick={() => dispatch({ type: 'mute-toggled' })}
            aria-pressed={muted}
            className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium ${
              muted
                ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
                : 'border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900'
            }`}
          >
            <Icon path={muted ? ICONS.microphoneOff : ICONS.microphone} className="h-4 w-4" />
            {muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        {busy ? (
          <button
            type="button"
            onClick={onInterrupt}
            className="flex items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            <Icon path={ICONS.stop} className="h-4 w-4" />
            Stop
          </button>
        ) : null}
        <button
          type="button"
          onClick={close}
          className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Type instead
        </button>
      </div>
    </div>
  );
}
