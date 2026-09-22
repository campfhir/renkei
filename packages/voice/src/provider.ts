/**
 * The contract every voice vendor is held to. The chat, its routes and the
 * preferences page speak only this: a list of voices, text in → audio out,
 * audio in → text out. Which service answers is the org's business
 * (`config.ts`), and swapping Azure for another vendor is a new file beside
 * `azure-speech.ts` plus one case in `createVoiceProvider` — nothing above
 * this line changes.
 *
 * Deliberately narrow. No streaming recognition session, no SSML in the
 * request: the immersive voice mode cuts the microphone into utterances in
 * the browser and transcribes each one whole, which every vendor can do
 * with one HTTP call — told the language, or asked to hear which one it
 * was. A vendor-specific extra (styles, pitch) belongs in the vendor file
 * until a second vendor needs it too.
 */

export interface VoiceInfo {
  /** The identifier the vendor wants back in a synthesis request. */
  id: string;
  /** What a person sees in a picker. */
  name: string;
  /** BCP-47, e.g. `en-US`. */
  locale: string;
  gender: 'female' | 'male' | 'neutral' | null;
  /**
   * What the voice is like, in the vendor's words when it has any —
   * "Warm, friendly · conversation, customer service" — for a picker to
   * show and search; null when the vendor says nothing.
   */
  description: string | null;
  /** Speaks other languages than its own well, so a language change need not drop it. */
  multilingual: boolean;
}

export interface SynthesisRequest {
  text: string;
  /** A `VoiceInfo.id`; the vendor chooses when null. */
  voice: string | null;
  /** 1 is the vendor's natural pace; 0.5 is half speed, 2 double. */
  rate: number;
  /** The text's language, for vendors that need it beside the voice. */
  locale: string;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  contentType: string;
  /** The encoded audio, streamed as the vendor hands it over. */
  body: ReadableStream<Uint8Array>;
  /**
   * The encoding's constant bitrate, when it has one: what turns the
   * bytes streamed into seconds of audio for the usage ledger without
   * decoding. Absent for a variable-rate encoding.
   */
  bitrateKbps?: number;
}

export interface TranscriptionRequest {
  /** The recording's bytes, whole: an utterance is a few hundred KB at most. */
  audio: ArrayBuffer;
  /** What the browser recorded — the routes accept only 16 kHz mono PCM WAV. */
  contentType: string;
  /**
   * BCP-47 language to recognise — or, with `detectLanguage`, the language
   * to fall back to when the vendor cannot tell which one was spoken.
   */
  locale: string;
  /**
   * Let the vendor hear which language was spoken instead of being told:
   * the person says something in any language and gets it back as said.
   */
  detectLanguage: boolean;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  /** Empty when the vendor heard no speech. */
  text: string;
  /** The language the words were recognised in; null when the vendor did not say. */
  locale: string | null;
}

export type VoiceErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'invalid_request'
  | 'timeout'
  | 'network'
  | 'provider_error';

export interface VoiceError {
  kind: VoiceErrorKind;
  message: string;
}

export type VoiceOutcome<T> = { ok: true; val: T } | { ok: false; error: VoiceError };

export interface VoiceProvider {
  /** Which vendor this is, for logs and the admin page. */
  readonly kind: string;
  listVoices(signal?: AbortSignal): Promise<VoiceOutcome<VoiceInfo[]>>;
  synthesize(request: SynthesisRequest): Promise<VoiceOutcome<SynthesisResult>>;
  transcribe(request: TranscriptionRequest): Promise<VoiceOutcome<TranscriptionResult>>;
}

/** The one fetch shape the vendor files take, so tests can hand in a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The playback speeds a person may pick; anything outside is clamped. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

export function clampRate(rate: unknown): number {
  const value = typeof rate === 'number' && Number.isFinite(rate) ? rate : 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(value * 100) / 100));
}

/** Where an HTTP status lands in the error taxonomy, shared by the vendors. */
export function errorKindOf(status: number, body: string): VoiceErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return 'invalid_request';
  }
  if (/invalid[_ ]?(api[_ ]?)?key|unauthorized|access denied/i.test(body)) return 'auth';
  return 'provider_error';
}

/** A fetch failure as an outcome: aborts are timeouts, the rest is network. */
export function fetchFailure(error: unknown): VoiceError {
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'timeout', message: 'The voice service did not answer in time.' };
  }
  return {
    kind: 'network',
    message: error instanceof Error ? error.message : 'The voice service could not be reached.',
  };
}
