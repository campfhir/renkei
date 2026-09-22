/**
 * The voice routes as the browser calls them, typed once. Audio comes back
 * as a Blob (a sentence of MP3, played straight from an object URL); the
 * rest is the `{ data, error }` shape the chat client uses — a failure is
 * a message the UI shows, never a throw.
 */

import { getJson, sendJsonFull } from '@/lib/fetch-json';
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

const base = (tenantId: string) => `/api/tenant/${tenantId}/voice`;

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === 'object' && body !== null) {
    const record: Record<string, unknown> = { ...body };
    if (typeof record.error === 'string') return record.error;
  }
  return `${fallback} (${response.status})`;
}

export const voiceClient = {
  status: (tenantId: string) => getJson<VoiceStatus>(base(tenantId)),

  /** One piece of text as audio. Aborting the signal drops the request. */
  synthesize: async (
    tenantId: string,
    request: SpeechRequest,
    signal?: AbortSignal
  ): Promise<{ data: Blob | null; error: string | null }> => {
    try {
      const response = await fetch(`${base(tenantId)}/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) {
        return { data: null, error: await errorOf(response, 'Speech failed') };
      }
      return { data: await response.blob(), error: null };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { data: null, error: null };
      }
      return { data: null, error: 'Could not reach the server' };
    }
  },

  /**
   * One utterance (16 kHz mono PCM WAV) as text; empty when nothing was
   * said. Told the language, or with `detectLanguage` asked to hear which
   * one it was, the named language being the fallback.
   */
  transcribe: async (
    tenantId: string,
    wav: ArrayBuffer,
    hearing: { locale: string | null; detectLanguage: boolean },
    signal?: AbortSignal
  ): Promise<{ data: { text: string } | null; error: string | null }> => {
    const params = new URLSearchParams();
    if (hearing.locale) params.set('locale', hearing.locale);
    if (hearing.detectLanguage) params.set('detect', '1');
    const encoded = params.toString();
    const query = encoded ? `?${encoded}` : '';
    try {
      const response = await fetch(`${base(tenantId)}/transcribe${query}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
        signal,
      });
      if (!response.ok) {
        return { data: null, error: await errorOf(response, 'Transcription failed') };
      }
      const body: unknown = await response.json().catch(() => null);
      const text =
        typeof body === 'object' && body !== null && 'text' in body && typeof body.text === 'string'
          ? body.text
          : '';
      return { data: { text }, error: null };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { data: null, error: null };
      }
      return { data: null, error: 'Could not reach the server' };
    }
  },

  /** Save this person's voice preferences (the whole document). */
  savePrefs: (tenantId: string, prefs: VoicePrefs) =>
    sendJsonFull<{ voice: VoicePrefs }>(`/api/tenant/${tenantId}/preferences`, 'PUT', {
      voice: prefs,
    }),
};
