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
 * for a press instead of a voice: Talk opens the recording, Done closes
 * and sends it, and a ten-second silence closes it unasked. Pressing
 * Talk over a reply interrupts it the way speaking over it does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { UtteranceRecorder } from '@/lib/voice/recorder';
import { voiceClient } from '@/lib/voice/client';
import type { SpeechQueue, SpeechQueueState } from '@/lib/voice/speech-queue';
import { speakableText } from '@/lib/voice/speech-text';
import { LevelEmitter } from '@/lib/voice/levels';
import VoiceWave, { type WaveAccent, type WaveTone } from './voice-wave';

type Phase =
  'starting' | 'listening' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export default function VoiceMode({
  tenantId,
  locale,
  queue,
  queueState,
  running,
  replyText,
  accent,
  userAccent,
  echoCancellation,
  microphone,
  pushToTalk,
  onSend,
  onInterrupt,
  onClose,
}: {
  tenantId: string;
  /** The language to listen for. */
  locale: string;
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
  /** Send an utterance as a message; false when it could not be sent. */
  onSend: (text: string) => Promise<boolean>;
  /** Stop the reply: silence the voice and cancel the turn. */
  onInterrupt: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  // Push-to-talk: a take is open, between Talk and Done.
  const [recording, setRecording] = useState(false);
  // The microphone's loudness reaches the wave by subscription, never
  // through state: a render per reading would redraw the whole overlay.
  const micLevels = useRef(new LevelEmitter());
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<UtteranceRecorder | null>(null);
  // The latest values, for callbacks the recorder holds across renders.
  const latest = useRef({ running, queueState, onInterrupt, onSend });
  latest.current = { running, queueState, onInterrupt, onSend };

  useEffect(() => {
    const instance = new UtteranceRecorder({
      echoCancellation,
      deviceId: microphone,
      mode: pushToTalk ? 'manual' : 'auto',
      onSpeechStart: () => {
        if (pushToTalk) setRecording(true);
        const { running: busy, queueState: state, onInterrupt: interrupt } = latest.current;
        // Talking over the assistant: silence it and drop the reply.
        if (busy || state !== 'idle') interrupt();
      },
      onUtterance: (wav) => {
        void (async () => {
          setTranscribing(true);
          const result = await voiceClient.transcribe(tenantId, wav, locale);
          setTranscribing(false);
          if (result.error) {
            setError(result.error);
            return;
          }
          const text = result.data?.text.trim() ?? '';
          if (!text) return;
          setError(null);
          setTranscript(text);
          const sent = await latest.current.onSend(text);
          if (!sent) setError('The message could not be sent.');
        })();
      },
      onSpeechEnd: () => setRecording(false),
      onLevel: (next) => micLevels.current.emit(next),
      onError: (message) => {
        setError(message);
        setPhase('error');
      },
    });
    recorder.current = instance;
    void instance.start().then((ok) => {
      if (ok) setPhase('listening');
    });
    return () => {
      instance.stop();
      recorder.current = null;
      setRecording(false);
    };
  }, [tenantId, locale, echoCancellation, microphone, pushToTalk]);

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

  /** Push-to-talk: Talk opens a take (interrupting a reply), Done closes and sends it. */
  const toggleTake = useCallback(() => {
    const instance = recorder.current;
    if (!instance || !instance.active) return;
    if (instance.taking) instance.endTake();
    else instance.beginTake();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      // Space is Talk/Done, unless a control has the keyboard already.
      if (event.key === ' ' && pushToTalk && !muted && phase !== 'starting' && phase !== 'error') {
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
  }, [close, pushToTalk, muted, phase, toggleTake]);

  const label =
    phase === 'starting'
      ? 'Opening the microphone…'
      : phase === 'error'
        ? 'Voice mode could not start'
        : muted
          ? 'Muted — unmute to talk'
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
                      : 'Speaking — press Stop to interrupt';
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
  const busy = running || queueState !== 'idle';

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
        {error ? (
          <p className="max-w-md text-center text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}

        <div className="w-full max-w-xl space-y-3 text-sm">
          {transcript ? (
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-white">
                {transcript}
              </p>
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
            disabled={phase === 'starting' || phase === 'error' || muted}
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
