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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { UtteranceRecorder } from '@/lib/voice/recorder';
import { voiceClient } from '@/lib/voice/client';
import type { SpeechQueue, SpeechQueueState } from '@/lib/voice/speech-queue';
import { speakableText } from '@/lib/voice/speech-text';
import VoiceWave, { type WaveAccent, type WaveTone } from './voice-wave';

type Phase = 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export default function VoiceMode({
  tenantId,
  locale,
  queue,
  queueState,
  running,
  replyText,
  accent,
  userAccent,
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
  const [level, setLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<UtteranceRecorder | null>(null);
  // The latest values, for callbacks the recorder holds across renders.
  const latest = useRef({ running, queueState, onInterrupt, onSend });
  latest.current = { running, queueState, onInterrupt, onSend };

  useEffect(() => {
    const instance = new UtteranceRecorder({
      onSpeechStart: () => {
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
      // Twenty readings a second; only a visible change is worth a render.
      onLevel: (next) => setLevel((prev) => (Math.abs(prev - next) > 0.03 ? next : prev)),
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
    };
  }, [tenantId, locale]);

  // The speaker's own voice must not read as the person talking.
  useEffect(() => {
    recorder.current?.holdWhileSpeaking(queueState === 'speaking');
  }, [queueState]);
  // The speaker's loudness, for the wave while the assistant talks.
  useEffect(
    () =>
      queue.subscribeLevel((next) =>
        setOutputLevel((prev) => (Math.abs(prev - next) > 0.02 ? next : prev))
      ),
    [queue]
  );
  useEffect(() => {
    recorder.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    if (phase === 'error' || phase === 'starting') return;
    if (queueState === 'speaking') setPhase('speaking');
    else if (transcribing) setPhase('transcribing');
    else if (running || queueState === 'loading') setPhase('thinking');
    else setPhase('listening');
  }, [phase, queueState, running, transcribing]);

  const close = useCallback(() => {
    recorder.current?.stop();
    queue.stop();
    onClose();
  }, [queue, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const label =
    phase === 'starting'
      ? 'Opening the microphone…'
      : phase === 'error'
        ? 'Voice mode could not start'
        : muted
          ? 'Muted — unmute to talk'
          : phase === 'listening'
            ? 'Listening'
            : phase === 'transcribing'
              ? 'Heard you…'
              : phase === 'thinking'
                ? 'Thinking…'
                : 'Speaking — talk to interrupt';
  const tone: WaveTone =
    phase === 'speaking'
      ? 'speaking'
      : phase === 'thinking' || phase === 'transcribing'
        ? 'thinking'
        : phase === 'listening' && !muted
          ? 'listening'
          : 'idle';
  const waveLevel = tone === 'speaking' ? outputLevel : tone === 'listening' ? level : 0;
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
          level={waveLevel}
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
              Say something. Pause when you are done, and the reply is read to you. Speak over it to
              interrupt.
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-3 border-t border-gray-200 px-4 py-4 dark:border-gray-800">
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
