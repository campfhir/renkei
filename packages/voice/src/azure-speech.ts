/**
 * Azure AI Speech over its REST surfaces — the complete contract with the
 * vendor, readable in one file and unit-testable with a fake fetch:
 *
 *   voices   GET  https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list
 *   speech   POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *            body: SSML; header X-Microsoft-OutputFormat picks the encoding
 *   text     POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=…
 *            body: 16 kHz mono PCM WAV, at most 60 seconds
 *
 * A custom domain or private endpoint (`endpoint`) replaces the regional
 * hosts: Azure serves the same three paths under `{endpoint}/tts/…` and
 * `{endpoint}/stt/…` there.
 *
 * Every call carries the key in `Ocp-Apim-Subscription-Key`. Speed rides
 * inside the SSML as a prosody rate — the vendor renders it, so the audio
 * itself is at the chosen pace and the browser plays it as is.
 */

import type { VoiceConfig } from './config';
import {
  clampRate,
  errorKindOf,
  fetchFailure,
  type FetchLike,
  type SynthesisRequest,
  type SynthesisResult,
  type TranscriptionRequest,
  type TranscriptionResult,
  type VoiceInfo,
  type VoiceOutcome,
  type VoiceProvider,
} from './provider';

/** MP3 at 24 kHz: every browser plays it, and a sentence is a few KB. */
export const AZURE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
export const AZURE_OUTPUT_CONTENT_TYPE = 'audio/mpeg';

/** Azure's own ceiling on the short-audio recognition endpoint. */
export const AZURE_MAX_UTTERANCE_SECONDS = 60;

const VOICES_TIMEOUT_MS = 15_000;
const SPEECH_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The five characters SSML cannot carry raw. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 1 → `+0%`, 1.25 → `+25%`, 0.8 → `-20%` — the prosody rate SSML wants. */
export function prosodyRate(rate: number): string {
  const percent = Math.round((clampRate(rate) - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

/** The SSML document for one request, exported so a test can pin the wire shape. */
export function buildSsml(
  request: Pick<SynthesisRequest, 'text' | 'voice' | 'rate' | 'locale'>,
  fallbackVoice: string
): string {
  const voice = escapeXml(request.voice ?? fallbackVoice);
  const locale = escapeXml(request.locale);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${voice}"><prosody rate="${prosodyRate(request.rate)}">` +
    escapeXml(request.text) +
    `</prosody></voice></speak>`
  );
}

/** The three URLs, regional or under the org's custom endpoint. */
export function azureEndpoints(config: Pick<VoiceConfig, 'region' | 'endpoint'>): {
  voices: string;
  speech: string;
  transcribe: string;
} {
  if (config.endpoint) {
    const base = config.endpoint.replace(/\/+$/, '');
    return {
      voices: `${base}/tts/cognitiveservices/voices/list`,
      speech: `${base}/tts/cognitiveservices/v1`,
      transcribe: `${base}/stt/speech/recognition/conversation/cognitiveservices/v1`,
    };
  }
  return {
    voices: `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    speech: `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    transcribe: `https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`,
  };
}

/** Azure's voice row → ours. Rows without a short name are skipped. */
export function parseAzureVoice(row: unknown): VoiceInfo | null {
  if (!isRecord(row)) return null;
  const id = typeof row.ShortName === 'string' ? row.ShortName.trim() : '';
  const locale = typeof row.Locale === 'string' ? row.Locale.trim() : '';
  if (!id || !locale) return null;
  const display =
    typeof row.DisplayName === 'string' && row.DisplayName.trim()
      ? row.DisplayName.trim()
      : id.replace(`${locale}-`, '').replace(/Neural$/, '');
  const localName =
    typeof row.LocalName === 'string' && row.LocalName.trim() && row.LocalName.trim() !== display
      ? ` (${row.LocalName.trim()})`
      : '';
  const gender =
    row.Gender === 'Female'
      ? 'female'
      : row.Gender === 'Male'
        ? 'male'
        : row.Gender === 'Neutral'
          ? 'neutral'
          : null;
  return { id, name: `${display}${localName}`, locale, gender };
}

/**
 * The vendor's body, re-exposed so `onDone` runs once it has been read to
 * its end or the reader gave up — the synthesis timeout is armed for the
 * whole transfer, not just the headers, and this is where it is disarmed.
 */
function untilDrained(
  source: ReadableStream<Uint8Array>,
  onDone: () => void
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read().catch((error: unknown) => {
        onDone();
        controller.error(error);
        return null;
      });
      if (!next) return;
      if (next.done) {
        onDone();
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      onDone();
      return reader.cancel(reason);
    },
  });
}

/** A timeout signal that also follows the caller's own abort. */
function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onOuter = () => controller.abort();
  outer?.addEventListener('abort', onOuter, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}

async function failureOf(response: Response, what: string): Promise<VoiceOutcome<never>> {
  const body = await response.text().catch(() => '');
  const kind = errorKindOf(response.status, body);
  const message =
    kind === 'auth'
      ? 'The voice service rejected the key.'
      : kind === 'not_found'
        ? 'The voice service endpoint was not found — check the region or endpoint.'
        : kind === 'rate_limit'
          ? 'The voice service is rate-limited right now.'
          : `${what} failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`;
  return { ok: false, error: { kind, message } };
}

export class AzureSpeechProvider implements VoiceProvider {
  readonly kind = 'azure-speech';
  private readonly fetchImpl: FetchLike;
  private readonly urls: ReturnType<typeof azureEndpoints>;

  constructor(
    private readonly config: VoiceConfig,
    fetchImpl?: FetchLike
  ) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
    this.urls = azureEndpoints(config);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Ocp-Apim-Subscription-Key': this.config.apiKey,
      'User-Agent': 'renkei-voice',
      ...extra,
    };
  }

  async listVoices(signal?: AbortSignal): Promise<VoiceOutcome<VoiceInfo[]>> {
    const timeout = withTimeout(VOICES_TIMEOUT_MS, signal);
    try {
      const response = await this.fetchImpl(this.urls.voices, {
        method: 'GET',
        headers: this.headers(),
        signal: timeout.signal,
      });
      if (!response.ok) return failureOf(response, 'Listing voices');
      const parsed: unknown = await response.json().catch(() => null);
      if (!Array.isArray(parsed)) {
        return {
          ok: false,
          error: { kind: 'provider_error', message: 'The voice list was not readable.' },
        };
      }
      const voices = parsed.flatMap((row) => {
        const voice = parseAzureVoice(row);
        return voice ? [voice] : [];
      });
      voices.sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
      return { ok: true, val: voices };
    } catch (error) {
      return { ok: false, error: fetchFailure(error) };
    } finally {
      timeout.clear();
    }
  }

  async synthesize(request: SynthesisRequest): Promise<VoiceOutcome<SynthesisResult>> {
    const timeout = withTimeout(SPEECH_TIMEOUT_MS, request.signal);
    try {
      const response = await this.fetchImpl(this.urls.speech, {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
        }),
        body: buildSsml(request, this.config.defaultVoice),
        signal: timeout.signal,
      });
      if (!response.ok) {
        timeout.clear();
        return failureOf(response, 'Speech synthesis');
      }
      if (!response.body) {
        timeout.clear();
        return {
          ok: false,
          error: { kind: 'provider_error', message: 'The voice service sent no audio.' },
        };
      }
      return {
        ok: true,
        val: {
          contentType: AZURE_OUTPUT_CONTENT_TYPE,
          body: untilDrained(response.body, timeout.clear),
        },
      };
    } catch (error) {
      timeout.clear();
      return { ok: false, error: fetchFailure(error) };
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<VoiceOutcome<TranscriptionResult>> {
    const timeout = withTimeout(TRANSCRIBE_TIMEOUT_MS, request.signal);
    const url = `${this.urls.transcribe}?${new URLSearchParams({
      language: request.locale,
      format: 'simple',
    }).toString()}`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers({
          'Content-Type': request.contentType,
          Accept: 'application/json',
        }),
        body: request.audio,
        signal: timeout.signal,
      });
      if (!response.ok) return failureOf(response, 'Transcription');
      const parsed: unknown = await response.json().catch(() => null);
      if (!isRecord(parsed)) {
        return {
          ok: false,
          error: { kind: 'provider_error', message: 'The transcription was not readable.' },
        };
      }
      // NoMatch / InitialSilenceTimeout / BabbleTimeout: nothing said, not an error.
      if (parsed.RecognitionStatus !== 'Success') return { ok: true, val: { text: '' } };
      const text = typeof parsed.DisplayText === 'string' ? parsed.DisplayText.trim() : '';
      return { ok: true, val: { text } };
    } catch (error) {
      return { ok: false, error: fetchFailure(error) };
    } finally {
      timeout.clear();
    }
  }
}
