/**
 * The voice routes as the browser calls them, typed once. Audio comes back
 * as a Blob (a sentence of MP3, played straight from an object URL); the
 * rest is the `{ data, error }` shape the chat client uses — a failure is
 * a message the UI shows, never a throw.
 */

import { getJson, reportFetchFailure, sendJsonFull } from '@/lib/fetch-json';
import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceInfo } from '@renkei/voice';

export interface VoiceStatus {
  configured: boolean;
  provider?: string;
  defaults: { voice: string; locale: string } | null;
  prefs: VoicePrefs | null;
  voices: VoiceInfo[];
  voicesError?: string | null;
}

export interface SpeechRequest {
  text: string;
  voice: string | null;
  rate: number;
  locale: string | null;
}

/** The route's answer for a piece played as it arrives: raw samples, chunk by chunk. */
export type SpeechStream = ReadableStream<Uint8Array>;

const base = () => `/api/voice`;

async function errorOf(response: Response, url: string, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const record: Record<string, unknown> =
    typeof body === 'object' && body !== null ? { ...body } : {};
  const message =
    typeof record.error === 'string' ? record.error : `${fallback} (${response.status})`;
  reportFetchFailure('POST', url, response.status, message);
  return message;
}

function unreachable(url: string, error: unknown): { data: null; error: string | null } {
  if (error instanceof Error && error.name === 'AbortError') return { data: null, error: null };
  reportFetchFailure('POST', url, 0, 'Could not reach the server', error);
  return { data: null, error: 'Could not reach the server' };
}

export const voiceClient = {
  status: () => getJson<VoiceStatus>(base()),

  /** One piece of text as audio, whole (MP3). Aborting the signal drops the request. */
  synthesize: async (
    request: SpeechRequest,
    signal?: AbortSignal
  ): Promise<{ data: Blob | null; error: string | null }> => {
    try {
      const response = await fetch(`${base()}/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, format: 'mp3' }),
        signal,
      });
      if (!response.ok) {
        return { data: null, error: await errorOf(response, `${base()}/speech`, 'Speech failed') };
      }
      return { data: await response.blob(), error: null };
    } catch (error) {
      return unreachable(`${base()}/speech`, error);
    }
  },

  /**
   * One piece of text as raw samples (PCM_SAMPLE_RATE, 16-bit, mono),
   * handed over as they arrive, for a piece the person is waiting on.
   * Resolves once the vendor has started answering; the stream is the
   * rest. Aborting the signal drops the request and ends the stream.
   */
  synthesizeStream: async (
    request: SpeechRequest,
    signal?: AbortSignal
  ): Promise<{ data: SpeechStream | null; error: string | null }> => {
    try {
      const response = await fetch(`${base()}/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, format: 'pcm' }),
        signal,
      });
      if (!response.ok) {
        return { data: null, error: await errorOf(response, `${base()}/speech`, 'Speech failed') };
      }
      if (!response.body) {
        reportFetchFailure(
          'POST',
          `${base()}/speech`,
          response.status,
          'The voice service sent no audio'
        );
        return { data: null, error: 'The voice service sent no audio' };
      }
      return { data: response.body, error: null };
    } catch (error) {
      return unreachable(`${base()}/speech`, error);
    }
  },

  /**
   * One utterance (16 kHz mono PCM WAV) as text; empty when nothing was
   * said. Told the language, or with `detectLanguage` asked to hear which
   * one it was, the named language being the fallback.
   */
  transcribe: async (
    wav: ArrayBuffer,
    hearing: { locale: string | null; detectLanguage: boolean },
    signal?: AbortSignal
  ): Promise<{
    /** The words, and the language they were heard in when the vendor said. */
    data: { text: string; locale: string | null } | null;
    error: string | null;
  }> => {
    const params = new URLSearchParams();
    if (hearing.locale) params.set('locale', hearing.locale);
    if (hearing.detectLanguage) params.set('detect', '1');
    const encoded = params.toString();
    const query = encoded ? `?${encoded}` : '';
    try {
      const response = await fetch(`${base()}/transcribe${query}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
        signal,
      });
      if (!response.ok) {
        return {
          data: null,
          error: await errorOf(response, `${base()}/transcribe`, 'Transcription failed'),
        };
      }
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      const text = typeof record.text === 'string' ? record.text : '';
      const locale = typeof record.locale === 'string' && record.locale ? record.locale : null;
      return { data: { text, locale }, error: null };
    } catch (error) {
      return unreachable(`${base()}/transcribe`, error);
    }
  },

  /** Save this person's voice preferences (the whole document). */
  savePrefs: (prefs: VoicePrefs) =>
    sendJsonFull<{ voice: VoicePrefs }>(`/api/preferences`, 'PUT', {
      voice: prefs,
    }),
};
