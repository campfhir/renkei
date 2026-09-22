'use client';

/**
 * Hearing a voice before choosing it: one sentence in the voice's own
 * language (sample-phrase.ts), through a speech queue of its own so it
 * never disturbs a reply being read. `preview` plays a voice — or stops
 * it, pressed again while it plays — and `previewing` names the voice
 * playing so the picker can show Stop on its row. Null as the voice is
 * the org's default; its key is the empty string.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { samplePhrase } from './sample-phrase';
import { SpeechQueue } from './speech-queue';

export const DEFAULT_VOICE_KEY = '';

export function useVoicePreview(
  tenantId: string,
  options: {
    rate: number;
    /** This device's chosen speaker; null for the default. */
    outputDevice?: string | null;
    /** Called as a sample starts — to stop a reply being read, say. */
    onBeforePlay?: () => void;
  }
): {
  previewing: string | null;
  error: string | null;
  preview: (voice: string | null, locale: string) => void;
  stop: () => void;
} {
  const { rate, outputDevice = null, onBeforePlay } = options;
  const queueRef = useRef<SpeechQueue | null>(null);
  const playingRef = useRef<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const queue = new SpeechQueue(tenantId, setError);
    const unsubscribe = queue.subscribe((state) => {
      if (state !== 'idle') return;
      playingRef.current = null;
      setPreviewing(null);
    });
    queueRef.current = queue;
    return () => {
      unsubscribe();
      queue.dispose();
      queueRef.current = null;
    };
  }, [tenantId]);
  useEffect(() => {
    queueRef.current?.setOutputDevice(outputDevice);
  }, [outputDevice]);

  const stop = useCallback(() => {
    queueRef.current?.stop();
    playingRef.current = null;
    setPreviewing(null);
  }, []);

  const preview = useCallback(
    (voice: string | null, locale: string) => {
      const queue = queueRef.current;
      if (!queue) return;
      const key = voice ?? DEFAULT_VOICE_KEY;
      if (playingRef.current === key) {
        stop();
        return;
      }
      onBeforePlay?.();
      setError(null);
      queue.configure({ voice, rate, locale });
      queue.prime();
      // begin() silences what was playing, which reads as idle for a
      // moment; the playing mark is set only once the piece is queued.
      queue.begin('preview');
      queue.enqueue(samplePhrase(locale));
      queue.finish();
      playingRef.current = key;
      setPreviewing(key);
    },
    [rate, onBeforePlay, stop]
  );

  return { previewing, error, preview, stop };
}
