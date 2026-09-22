'use client';

/**
 * The immersive voice conversation: the chat, with the microphone as the
 * composer and the speaker as the message list. Opens over the thread,
 * listens through lib/voice/recorder.ts, sends each utterance as a turn
 * exactly as typing it would (so it lands in the same chat, with the same
 * tools, model and project), and reads the reply as it streams.
 *
 * Interruptions are the point. The moment the person starts speaking
 * while a reply is being read — or still being written — the voice stops
 * and the turn is cancelled; what they said is sent once they pause. The
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import type { ToolPermissionDecision } from '@/lib/chat/views';
import { spokenActivity, spokenAsk } from '@/lib/voice/activity';
import { localeLabel } from '@/lib/voice/catalog';
import { UtteranceRecorder } from '@/lib/voice/recorder';
import { spokenDecision } from '@/lib/voice/spoken-decision';
import { LIVE_REPLY_OWNER } from '@/lib/voice/use-reply-speech';
import { voiceClient } from '@/lib/voice/client';
import type { SpeechQueue, SpeechQueueState } from '@/lib/voice/speech-queue';
import { speakableText } from '@/lib/voice/speech-text';
import { LevelEmitter } from '@/lib/voice/levels';
import VoiceWave, { type WaveAccent, type WaveTone } from './voice-wave';
import type { PermissionPrompt } from './message-list';

/** A tool call in flight, for the activity line and its announcement. */
export interface VoiceActivity {
  id: string;
  name: string;
  /** What the model wrote just before the call — its own account of it, read aloud already. */
  said: string | null;
}

/** The last sentence of what the model said, for the line under the wave. */
function lastSentence(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g);
  const last = sentences?.[sentences.length - 1]?.trim();
  return (last && last.length > 0 ? last : text).replace(/[.!?]+$/, '');
}

/** Quiet this long while a reply is worked out earns a "still working on it". */
const STILL_WORKING_AFTER_MS = 20_000;

type Phase =
  'starting' | 'listening' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export default function VoiceMode({
  tenantId,
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
  onSend,
  onInterrupt,
  onClose,
}: {
  tenantId: string;
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
  /** Send an utterance as a message; false when it could not be sent. */
  onSend: (text: string) => Promise<boolean>;
  /** Stop the reply: silence the voice and cancel the turn. */
  onInterrupt: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  // Push-to-talk: a take is open, between Talk and Done; and the moment
  // before, while the microphone is opening for it.
  const [recording, setRecording] = useState(false);
  const [opening, setOpening] = useState(false);
  // The microphone's loudness reaches the wave by subscription, never
  // through state: a render per reading would redraw the whole overlay.
  const micLevels = useRef(new LevelEmitter());
  const [transcript, setTranscript] = useState<string | null>(null);
  // The language the last utterance was heard in, when it was not the set one.
  const [heard, setHeard] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<UtteranceRecorder | null>(null);
  // The latest values, for callbacks the recorder holds across renders.
  const latest = useRef({ running, queueState, onInterrupt, onSend, onHeard, permission });
  latest.current = { running, queueState, onInterrupt, onSend, onHeard, permission };
  // What the assistant is doing, as last announced; and when the voice
  // last had something to say, for the dead-air check.
  const [activityLine, setActivityLine] = useState<string | null>(null);
  const announced = useRef(new Set<string>());
  const lastVoiceAt = useRef(Date.now());
  const [deciding, setDeciding] = useState<ToolPermissionDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

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
      setDeciding(decision);
      setDecisionError(null);
      const failure = await ask.onDecide(ask.pending.toolUseId, decision);
      setDeciding(null);
      if (failure) {
        setDecisionError(failure);
        return;
      }
      narrate(
        decision === 'deny' ? 'Denied.' : decision === 'always' ? 'Always allowed.' : 'Allowed.'
      );
    },
    [narrate]
  );

  useEffect(() => {
    const instance = new UtteranceRecorder({
      echoCancellation,
      deviceId: microphone,
      mode: pushToTalk ? 'manual' : 'auto',
      onSpeechStart: () => {
        // A take was interrupted by the press that opened it (toggleTake).
        if (pushToTalk) {
          setRecording(true);
          return;
        }
        const {
          running: busy,
          queueState: state,
          onInterrupt: interrupt,
          permission: ask,
        } = latest.current;
        // An answer to the ask is not an interruption: the turn is parked
        // waiting for it, and cancelling it would throw the reply away.
        if (ask) return;
        // Talking over the assistant: silence it and drop the reply.
        if (busy || state !== 'idle') interrupt();
      },
      onUtterance: (wav) => {
        void (async () => {
          setTranscribing(true);
          const result = await voiceClient.transcribe(tenantId, wav, { locale, detectLanguage });
          setTranscribing(false);
          if (result.error) {
            setError(result.error);
            return;
          }
          const text = result.data?.text.trim() ?? '';
          if (!text) return;
          setError(null);
          setTranscript(text);
          const heardIn = result.data?.locale ?? null;
          setHeard(heardIn && heardIn !== locale ? heardIn : null);
          if (heardIn) latest.current.onHeard(heardIn);
          // While an ask is open, what is said is the answer to it.
          if (latest.current.permission) {
            const decision = spokenDecision(text);
            if (decision) await decide(decision);
            else narrate('Say allow, always allow, or deny.');
            return;
          }
          const sent = await latest.current.onSend(text);
          if (!sent) setError('The message could not be sent.');
        })();
      },
      onSpeechEnd: () => {
        setRecording(false);
        // Push-to-talk: the microphone is only open for the take.
        if (pushToTalk) {
          instance.stop();
          micLevels.current.emit(0);
        }
      },
      onLevel: (next) => micLevels.current.emit(next),
      onError: (message) => {
        setError(message);
        // Without a microphone there is no voice mode — unless it is only
        // wanted per take, when the next Talk can try again.
        if (!pushToTalk) setPhase('error');
      },
    });
    recorder.current = instance;
    if (pushToTalk) {
      setPhase('listening');
    } else {
      void instance.start().then((ok) => {
        if (ok) setPhase('listening');
      });
    }
    return () => {
      instance.stop();
      recorder.current = null;
      setRecording(false);
      setOpening(false);
    };
    // decide and narrate are stable for the queue's lifetime.
  }, [tenantId, locale, detectLanguage, echoCancellation, microphone, pushToTalk]);

  // The line under the wave says what is being done right now: the
  // model's own sentence about the call when it wrote one (a voice turn
  // is asked to), else the page's. A call the model did not introduce
  // is announced as it starts — the newest only, when several start at
  // once, so a burst of lookups is one sentence.
  useEffect(() => {
    const fresh = activity.filter((call) => !announced.current.has(call.id));
    for (const call of fresh) announced.current.add(call.id);
    const current = activity[activity.length - 1];
    const lineOf = (call: VoiceActivity) =>
      call.said ? lastSentence(call.said) : spokenActivity(call.name);
    if (fresh.length > 0) {
      const newest = fresh[fresh.length - 1];
      setActivityLine(lineOf(newest));
      if (!newest.said) narrate(`${spokenActivity(newest.name)}.`);
    } else if (current) {
      setActivityLine(lineOf(current));
    } else {
      setActivityLine(null);
    }
  }, [activity, narrate]);
  useEffect(() => {
    if (!running) announced.current.clear();
  }, [running]);

  // A long quiet while the reply is worked out gets a word, so a slow
  // answer is not mistaken for a dropped one.
  useEffect(() => {
    if (queueState === 'speaking') lastVoiceAt.current = Date.now();
  }, [queueState]);
  useEffect(() => {
    if (!running || permission) return;
    const timer = setInterval(() => {
      if (latest.current.queueState !== 'idle') return;
      if (Date.now() - lastVoiceAt.current < STILL_WORKING_AFTER_MS) return;
      narrate('Still working on it.');
    }, 5_000);
    return () => clearInterval(timer);
  }, [running, permission, narrate]);

  // The ask, spoken the moment it is raised.
  const askId = permission?.pending.toolUseId ?? null;
  useEffect(() => {
    if (!askId || !permission) return;
    setDecisionError(null);
    narrate(
      `Permission needed. The assistant wants to ${spokenAsk(permission.pending.name)}. Say allow, always allow, or deny.`
    );
    // Spoken once per ask, not on every re-render carrying it.
  }, [askId, narrate]);

  // Without echo cancellation the microphone has no use while the
  // assistant works — it is closed to speech anyway — so its track is
  // released for that time and opened again after, which is what lets a
  // headset play the reply in stereo. Stop makes "after" now.
  const busy = running || queueState !== 'idle';
  const releaseWhileBusy = !pushToTalk && !echoCancellation;
  useEffect(() => {
    const instance = recorder.current;
    if (!releaseWhileBusy || !instance || phase === 'starting' || phase === 'error') return;
    if (busy) {
      instance.stop();
      micLevels.current.emit(0);
    } else if (!instance.active) {
      void instance.start();
    }
  }, [releaseWhileBusy, busy, phase]);

  // The speaker stays open for the whole conversation, so a reply's first
  // word is not lost to a headset waking up (lib/voice/speech-queue.ts).
  useEffect(() => queue.hold(), [queue]);

  // The speaker's own voice must not read as the person talking: with
  // echo cancellation, a higher bar while it speaks; without, no
  // listening at all until it has finished.
  useEffect(() => {
    recorder.current?.holdWhileSpeaking(queueState === 'speaking');
  }, [queueState]);
  // Push-to-talk needs no such guard: nothing starts without a press.
  useEffect(() => {
    recorder.current?.setMuted(
      muted || (!pushToTalk && !echoCancellation && queueState === 'speaking')
    );
  }, [muted, echoCancellation, pushToTalk, queueState]);

  useEffect(() => {
    if (phase === 'error' || phase === 'starting') return;
    if (recording) setPhase('recording');
    else if (queueState === 'speaking') setPhase('speaking');
    else if (transcribing) setPhase('transcribing');
    else if (running || queueState === 'loading') setPhase('thinking');
    else setPhase('listening');
  }, [phase, recording, queueState, running, transcribing]);

  const close = useCallback(() => {
    recorder.current?.stop();
    queue.stop();
    onClose();
  }, [queue, onClose]);

  /**
   * Push-to-talk: Talk interrupts a reply, opens the microphone and a
   * take; Done closes and sends it, and the microphone closes with it.
   */
  const toggleTake = useCallback(() => {
    const instance = recorder.current;
    if (!instance || opening) return;
    if (instance.taking) {
      instance.endTake();
      return;
    }
    const {
      running: turn,
      queueState: state,
      onInterrupt: interrupt,
      permission: ask,
    } = latest.current;
    if (!ask && (turn || state !== 'idle')) interrupt();
    setError(null);
    setOpening(true);
    void instance.start().then((ok) => {
      setOpening(false);
      if (ok && recorder.current === instance) instance.beginTake();
    });
  }, [opening]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      // Space is Talk/Done, unless a control has the keyboard already.
      if (event.key === ' ' && pushToTalk && phase !== 'starting' && phase !== 'error') {
        if (
          event.target instanceof Element &&
          event.target.closest('button, input, select, textarea, a')
        ) {
          return;
        }
        event.preventDefault();
        toggleTake();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, pushToTalk, phase, toggleTake]);

  const label =
    phase === 'starting'
      ? 'Opening the microphone…'
      : phase === 'error'
        ? 'Voice mode could not start'
        : permission
          ? 'Permission needed — say allow, always allow, or deny'
          : muted
            ? 'Muted — unmute to talk'
            : opening
              ? 'Opening the microphone…'
              : phase === 'recording'
                ? 'Recording — press Done when you have finished'
                : phase === 'listening'
                  ? pushToTalk
                    ? 'Press Talk to speak'
                    : 'Listening'
                  : phase === 'transcribing'
                    ? 'Heard you…'
                    : phase === 'thinking'
                      ? 'Thinking…'
                      : pushToTalk
                        ? 'Speaking — press Talk to interrupt'
                        : echoCancellation
                          ? 'Speaking — talk to interrupt'
                          : 'Speaking — press Stop to talk';
  const tone: WaveTone =
    phase === 'speaking'
      ? 'speaking'
      : phase === 'thinking' || phase === 'transcribing'
        ? 'thinking'
        : (phase === 'recording' || (phase === 'listening' && !pushToTalk)) && !muted
          ? 'listening'
          : 'idle';
  // Whose sound the wave follows: the speaker's, the microphone's, or none.
  const waveLevels = tone === 'speaking' ? queue : tone === 'listening' ? micLevels.current : null;
  const spokenReply = replyText ? speakableText(replyText) : '';

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
        {running && !permission && (activityLine || phase === 'thinking') ? (
          <p className="-mt-4 text-sm text-gray-500" aria-live="polite">
            {activityLine ? `${activityLine}…` : thinking ? 'Thinking it through…' : 'Working…'}
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
              {spokenReply.length > 700 ? `…${spokenReply.slice(-700)}` : spokenReply}
            </p>
          ) : null}
          {!transcript && !spokenReply && phase === 'listening' ? (
            <p className="text-center text-gray-500">
              {pushToTalk
                ? 'Press Talk, say what you want, then press Done. Ten seconds of silence ends it too. Press Talk over a reply to interrupt it.'
                : 'Say something. Pause when you are done, and the reply is read to you. Speak over it to interrupt.'}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-3 border-t border-gray-200 px-4 py-4 dark:border-gray-800">
        {pushToTalk ? (
          <button
            type="button"
            onClick={toggleTake}
            disabled={phase === 'starting' || phase === 'error' || opening}
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
            onClick={() => setMuted((value) => !value)}
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
