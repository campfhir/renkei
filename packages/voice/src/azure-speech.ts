/**
 * Azure AI Speech over its REST surfaces — the complete contract with the
 * vendor, readable in one file and unit-testable with a fake fetch:
 *
 *   voices   GET  https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list
 *   speech   POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *            body: SSML; header X-Microsoft-OutputFormat picks the encoding
 *   text     POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=…
 *            body: 16 kHz mono PCM WAV, at most 60 seconds
 *   detect   POST https://{region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=…
 *            multipart: the same WAV as `audio`, and a `definition` naming
 *            no locale, so the vendor says which language it heard
 *
 * The short-audio endpoint has to be told the language; the fast
 * transcription one works it out, and is what a request with
 * `detectLanguage` goes to. It is not served in every region, so a
 * request it cannot take falls back to the short-audio endpoint with the
 * language the request named.
 *
 * A custom domain or private endpoint (`endpoint`) replaces the regional
 * hosts: Azure serves the same paths under `{endpoint}/tts/…`,
 * `{endpoint}/stt/…` and `{endpoint}/speechtotext/…` there.
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
  PCM_SAMPLE_RATE,
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
/** The format above is constant-rate: 48 kbit of MP3 is one second of audio. */
export const AZURE_OUTPUT_BITRATE_KBPS = 48;
/** Raw 16-bit mono samples at PCM_SAMPLE_RATE, playable from the first chunk. */
export const AZURE_PCM_OUTPUT_FORMAT = 'raw-24khz-16bit-mono-pcm';
export const AZURE_PCM_CONTENT_TYPE = 'audio/pcm';
/** 24 000 samples of 16 bits a second. */
export const AZURE_PCM_BITRATE_KBPS = (PCM_SAMPLE_RATE * 16) / 1000;

/** Azure's own ceiling on the short-audio recognition endpoint. */
export const AZURE_MAX_UTTERANCE_SECONDS = 60;

/** The fast transcription API version, the one with language identification. */
export const AZURE_FAST_TRANSCRIPTION_API_VERSION = '2024-11-15';

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

/** The four URLs, regional or under the org's custom endpoint. */
export function azureEndpoints(config: Pick<VoiceConfig, 'region' | 'endpoint'>): {
  voices: string;
  speech: string;
  transcribe: string;
  detect: string;
} {
  const detectPath = `speechtotext/transcriptions:transcribe?api-version=${AZURE_FAST_TRANSCRIPTION_API_VERSION}`;
  if (config.endpoint) {
    const base = config.endpoint.replace(/\/+$/, '');
    return {
      voices: `${base}/tts/cognitiveservices/voices/list`,
      speech: `${base}/tts/cognitiveservices/v1`,
      transcribe: `${base}/stt/speech/recognition/conversation/cognitiveservices/v1`,
      detect: `${base}/${detectPath}`,
    };
  }
  return {
    voices: `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    speech: `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    transcribe: `https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`,
    detect: `https://${config.region}.api.cognitive.microsoft.com/${detectPath}`,
  };
}

/**
 * The words and the language out of a fast-transcription body, exported so
 * a test can pin the shape. The text is the vendor's own joining of the
 * phrases; the language is the longest phrase's, since one utterance is
 * one language and a stray short phrase the vendor heard differently must
 * not name it.
 */
export function parseAzureDetection(body: unknown): TranscriptionResult | null {
  if (!isRecord(body) || !Array.isArray(body.combinedPhrases)) return null;
  const text = body.combinedPhrases
    .map((row) => (isRecord(row) && typeof row.text === 'string' ? row.text.trim() : ''))
    .filter((piece) => piece.length > 0)
    .join(' ');
  let locale: string | null = null;
  let longest = -1;
  for (const row of Array.isArray(body.phrases) ? body.phrases : []) {
    if (!isRecord(row) || typeof row.locale !== 'string' || !row.locale.trim()) continue;
    const length = typeof row.durationMilliseconds === 'number' ? row.durationMilliseconds : 0;
    if (length > longest) {
      longest = length;
      locale = row.locale.trim();
    }
  }
  return { text, locale };
}

/** A vendor list of words as one lowercase, comma-separated phrase; empty when it is not one. */
function joinedTags(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    .map((tag) => tag.trim().toLowerCase())
    .join(', ');
}

/**
 * The voice's character out of Azure's `VoiceTag`: its personalities
 * ("Friendly, Warm") and the scenarios it was made for ("Conversation,
 * Customer service"), each list lowercased and the two joined with a dot.
 */
export function describeAzureVoice(row: Record<string, unknown>): string | null {
  const tag = isRecord(row.VoiceTag) ? row.VoiceTag : {};
  const personalities = joinedTags(tag.VoicePersonalities);
  const scenarios = joinedTags(tag.TailoredScenarios);
  const parts = [personalities, scenarios].filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Azure's voice row → ours. Rows without a short name are skipped. */
export function parseAzureVoice(row: unknown): VoiceInfo | null {
  if (!isRecord(row)) return null;
  const id = typeof row.ShortName === 'string' ? row.ShortName.trim() : '';
  const locale = typeof row.Locale === 'string' ? row.Locale.trim() : '';
  if (!id || !locale) return null;
  // A voice with secondary locales is one Azure trained across languages;
  // its name says so too, for lists that omit them.
  const multilingual =
    (Array.isArray(row.SecondaryLocaleList) && row.SecondaryLocaleList.length > 0) ||
    /multilingual/i.test(id);
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
  return {
    id,
    name: `${display}${localName}`,
    locale,
    gender,
    description: describeAzureVoice(row),
    multilingual,
  };
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
    const pcm = request.format === 'pcm';
    try {
      const response = await this.fetchImpl(this.urls.speech, {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': pcm ? AZURE_PCM_OUTPUT_FORMAT : AZURE_OUTPUT_FORMAT,
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
          contentType: pcm ? AZURE_PCM_CONTENT_TYPE : AZURE_OUTPUT_CONTENT_TYPE,
          body: untilDrained(response.body, timeout.clear),
          bitrateKbps: pcm ? AZURE_PCM_BITRATE_KBPS : AZURE_OUTPUT_BITRATE_KBPS,
        },
      };
    } catch (error) {
      timeout.clear();
      return { ok: false, error: fetchFailure(error) };
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<VoiceOutcome<TranscriptionResult>> {
    if (!request.detectLanguage) return this.recognize(request);
    const detected = await this.detect(request);
    // Fast transcription is missing from some regions (a 404) and refuses
    // speech it cannot place in any language (a 400); the language the
    // request named is the next best guess, and the short-audio endpoint
    // is everywhere.
    if (
      !detected.ok &&
      (detected.error.kind === 'not_found' || detected.error.kind === 'invalid_request')
    ) {
      return this.recognize(request);
    }
    return detected;
  }

  /** The short-audio endpoint: told the language, answers with the words. */
  private async recognize(
    request: TranscriptionRequest
  ): Promise<VoiceOutcome<TranscriptionResult>> {
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
      if (parsed.RecognitionStatus !== 'Success') {
        return { ok: true, val: { text: '', locale: request.locale } };
      }
      const text = typeof parsed.DisplayText === 'string' ? parsed.DisplayText.trim() : '';
      return { ok: true, val: { text, locale: request.locale } };
    } catch (error) {
      return { ok: false, error: fetchFailure(error) };
    } finally {
      timeout.clear();
    }
  }

  /** Fast transcription: asked nothing about the language, answers with the words and which it was. */
  private async detect(request: TranscriptionRequest): Promise<VoiceOutcome<TranscriptionResult>> {
    const timeout = withTimeout(TRANSCRIBE_TIMEOUT_MS, request.signal);
    const form = new FormData();
    form.append('audio', new Blob([request.audio], { type: 'audio/wav' }), 'utterance.wav');
    // A definition naming no locale asks the vendor to pick from every
    // language it knows; naming one would fix it, naming a few would only
    // be a hint. The multipart boundary is fetch's to set, so no
    // Content-Type header here.
    form.append('definition', JSON.stringify({}));
    try {
      const response = await this.fetchImpl(this.urls.detect, {
        method: 'POST',
        headers: this.headers({ Accept: 'application/json' }),
        body: form,
        signal: timeout.signal,
      });
      if (!response.ok) return failureOf(response, 'Transcription');
      const parsed: unknown = await response.json().catch(() => null);
      const result = parseAzureDetection(parsed);
      if (!result) {
        return {
          ok: false,
          error: { kind: 'provider_error', message: 'The transcription was not readable.' },
        };
      }
      return { ok: true, val: result };
    } catch (error) {
      return { ok: false, error: fetchFailure(error) };
    } finally {
      timeout.clear();
    }
  }
}
