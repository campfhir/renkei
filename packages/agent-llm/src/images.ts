/**
 * Image generation models, over two wire surfaces:
 *
 *   - 'images' — the OpenAI Images API (gpt-image-* on OpenAI itself, and
 *     on Azure AI Foundry's v1 surface): POST {base}/images/generations
 *     with `size`, `quality`, `output_format`, `background`.
 *   - 'flux' — Black Forest Labs' FLUX models as Azure AI Foundry serves
 *     them (FLUX.2-flex, FLUX.1 Kontext pro, …): POST to the model's own
 *     provider URL, e.g.
 *     https://{resource}.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-flex
 *     — the base URL IS the full endpoint, since the path names the model —
 *     with `width` and `height` in place of `size`, and no quality,
 *     format or background knobs.
 *
 * With a source image (ImageRequest.image) the call is an EDIT — "make it
 * bluer" applied to a picture already drawn: the OpenAI surface posts
 * multipart to /images/edits (`image` is the file), and FLUX sends the
 * picture as base64 in `input_image`, the field Black Forest Labs' own API
 * edits with. The prompt is the person's, untouched, either way.
 *
 * Both are spoken with the same credential-header rules as the chat
 * adapter (openai.ts): an Azure host gets Bearer alone, anything else both
 * headers, because Azure's gateway fails a request carrying a pair.
 *
 * These models are not chat models and never go through LlmProvider: one
 * request, one picture back. gpt-image models always answer base64
 * (`b64_json`), which is what this returns — bytes the caller must still
 * treat as untrusted (the chat's image tool runs them through
 * @renkei/document-render before keeping them). The media type comes from
 * the bytes themselves, not from the format asked for: FLUX answers PNG
 * whatever is requested, and a gateway may ignore `output_format`.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { isAzureHost, looksLikeCredentialFailure, transportErrorKind } from './contract';
import type { LlmErrorKind } from './contract';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Generation takes 10–30 s, up to a minute for complex prompts. */
const REQUEST_TIMEOUT_MS = 180_000;
/** Larger than any 4K PNG gpt-image returns; a guard on a hostile or broken gateway. */
const RESPONSE_MAX_BYTES = 40 * 1024 * 1024;

/** The wire dialects an image generation model can speak. */
export const IMAGE_SURFACES = ['images', 'flux'] as const;
export type ImageSurface = (typeof IMAGE_SURFACES)[number];

export interface ImageModelConfig {
  apiKey: string;
  /** Model id — for Azure AI Foundry, the DEPLOYMENT name (FLUX: the model name, e.g. FLUX.2-flex). */
  model: string;
  /** Which wire dialect; absent = the OpenAI Images API. */
  surface?: ImageSurface;
  /** The API root; for 'flux', the model's full provider URL. */
  baseUrl?: string | null;
  /** Azure surfaces version routes with ?api-version=; null = omit. */
  apiVersion?: string | null;
}

export interface ImageRequest {
  prompt: string;
  /** 'auto', or WIDTHxHEIGHT; the model's own limits apply. */
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  outputFormat?: 'png' | 'jpeg';
  /** 'transparent' needs a PNG. */
  background?: 'auto' | 'transparent';
  /**
   * A picture to start from, which makes the call an edit. Already
   * validated by the caller; the filename is only what the multipart part
   * is called.
   */
  image?: { bytes: Buffer; mediaType: 'image/png' | 'image/jpeg'; filename: string };
  signal?: AbortSignal;
}

/** What the provider billed, when it said (gpt-image does; FLUX does not). */
export interface ImageUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GeneratedImage {
  /** The image as the provider sent it — untrusted until validated. */
  bytes: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  /** Tokens billed for the call; null when the provider reports none. */
  usage: ImageUsage | null;
}

/** An error kind of the chat adapters, plus the provider's safety system saying no. */
export type ImageErrorKind = LlmErrorKind | 'content_filter';

function errorKindOf(status: number, body: string): ImageErrorKind {
  // The wording differs by route: OpenAI's codes, Azure's "safety system", and the
  // gateway's "blocked due to content moderation policies" on the native FLUX route.
  if (
    /content_?filter|content_policy_violation|moderation|content safety|safety system/i.test(body)
  ) {
    return 'content_filter';
  }
  if (looksLikeCredentialFailure(body)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (status === 529 || status === 502 || status === 503 || status === 504) return 'overloaded';
  return 'provider_error';
}

/** What the chosen surface sends: where, and the body — JSON, or multipart for an OpenAI edit. */
function requestFor(
  config: ImageModelConfig,
  request: ImageRequest
): { url: string; body: Record<string, unknown> | FormData } {
  const version = config.apiVersion ? `?api-version=${encodeURIComponent(config.apiVersion)}` : '';
  if (config.surface === 'flux') {
    // The base URL is the model's own endpoint; a query string already on it is kept.
    const endpoint = (config.baseUrl ?? '').replace(/\/+$/, '');
    // FLUX takes pixels, not a size name; 'auto' (or anything unparsable) is 1024x1024.
    const match = /^(\d{2,5})x(\d{2,5})$/.exec(request.size ?? '');
    return {
      url: version
        ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}${version.slice(1)}`
        : endpoint,
      body: {
        prompt: request.prompt,
        model: config.model,
        width: match ? Number(match[1]) : 1024,
        height: match ? Number(match[2]) : 1024,
        num_images: 1,
        output_format: request.outputFormat ?? 'png',
        // An edit: the picture to start from, as base64 (BFL's `input_image`).
        ...(request.image ? { input_image: request.image.bytes.toString('base64') } : {}),
      },
    };
  }
  // Tolerate a pasted FULL endpoint: the path is appended here.
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/images\/(generations|edits)$/, '');
  const format = request.outputFormat ?? 'png';
  const fields = {
    model: config.model,
    prompt: request.prompt,
    n: 1,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    output_format: format,
    // Transparency only exists in PNG; asking for it on a JPEG is a 400.
    ...(request.background === 'transparent' && format === 'png'
      ? { background: 'transparent' }
      : {}),
  };
  if (!request.image) return { url: `${baseUrl}/images/generations${version}`, body: fields };
  // An edit is multipart: every field a form part, the picture a file part.
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append(
    'image',
    new Blob([new Uint8Array(request.image.bytes)], { type: request.image.mediaType }),
    request.image.filename
  );
  return { url: `${baseUrl}/images/edits${version}`, body: form };
}

/**
 * `usage` as the routes send it: gpt-image's {input_tokens, output_tokens},
 * or Azure's native provider shape {prompt_tokens, completion_tokens}.
 * Null when absent or not numbers.
 */
function usageOf(raw: unknown): ImageUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input: unknown = Reflect.get(raw, 'input_tokens') ?? Reflect.get(raw, 'prompt_tokens');
  const output: unknown =
    Reflect.get(raw, 'output_tokens') ?? Reflect.get(raw, 'completion_tokens');
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  const whole = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return { inputTokens: whole(input), outputTokens: whole(output) };
}

/** PNG or JPEG by magic number; null for anything else (WebP, HTML, junk). */
function mediaTypeOf(bytes: Buffer): GeneratedImage['mediaType'] | null {
  if (
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/**
 * Fetches a picture the provider answered as a link. Only https to a named
 * host (no IP literal, no localhost), no redirects, no credentials sent,
 * capped in size and time — the link is provider-supplied, so it is treated
 * as untrusted input.
 */
async function downloadImage(
  link: string,
  signal: AbortSignal | undefined
): Promise<Result<Buffer, ImageErrorKind>> {
  let target: URL;
  try {
    target = new URL(link);
  } catch {
    return err('provider_error' as const, { message: 'The image link was not a URL.' });
  }
  const host = target.hostname.toLowerCase();
  const literal = /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[');
  if (
    target.protocol !== 'https:' ||
    literal ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return err('provider_error' as const, {
      message: 'The image link was not a public https URL.',
    });
  }
  try {
    const response = await fetch(target, {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return err('provider_error' as const, {
        message: `The image link answered ${response.status}.`,
      });
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > RESPONSE_MAX_BYTES) {
      return err('provider_error' as const, { message: 'The image is larger than allowed.' });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > RESPONSE_MAX_BYTES) {
      return err('provider_error' as const, { message: 'The image is larger than allowed.' });
    }
    return ok(bytes);
  } catch (error) {
    return err(transportErrorKind(error, signal), {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function generateImage(
  config: ImageModelConfig,
  request: ImageRequest
): Promise<Result<GeneratedImage, ImageErrorKind>> {
  if (config.surface === 'flux' && !config.baseUrl) {
    return err('invalid_request' as const, {
      message:
        'A FLUX model needs its endpoint as the base URL (…/providers/blackforestlabs/v1/<model>).',
    });
  }
  const { url, body } = requestFor(config, request);
  const authority =
    config.surface === 'flux' ? (config.baseUrl ?? '') : config.baseUrl || DEFAULT_BASE_URL;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        // A multipart body carries its own content type, with the boundary fetch picks.
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${config.apiKey}`,
        ...(isAzureHost(authority) ? {} : { 'api-key': config.apiKey }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal: request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return err(transportErrorKind(error, request.signal), {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return err(errorKindOf(response.status, text), {
      message: `Images endpoint ${response.status}: ${text.slice(0, 500)}`,
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return err('provider_error' as const, { message: 'The images endpoint did not answer JSON.' });
  }
  const parsed: { data?: unknown; usage?: unknown; error?: { message?: unknown } } =
    typeof payload === 'object' && payload !== null ? payload : {};
  if (parsed.error) {
    return err(errorKindOf(200, JSON.stringify(parsed.error)), {
      message: String(parsed.error.message ?? 'The images endpoint reported an error.'),
    });
  }
  const first: unknown = Array.isArray(parsed.data) ? parsed.data[0] : undefined;
  const field = (name: string): unknown =>
    typeof first === 'object' && first !== null ? Reflect.get(first, name) : undefined;
  const b64 = field('b64_json');
  const link = field('url');
  let bytes: Buffer;
  if (typeof b64 === 'string' && b64) {
    if (b64.length > Math.ceil((RESPONSE_MAX_BYTES * 4) / 3)) {
      return err('provider_error' as const, { message: 'The image is larger than allowed.' });
    }
    bytes = Buffer.from(b64, 'base64');
  } else if (typeof link === 'string' && link) {
    // FLUX routes may answer a URL instead of bytes.
    const downloaded = await downloadImage(link, request.signal);
    if (!downloaded.ok) return downloaded;
    bytes = downloaded.val;
  } else {
    return err('provider_error' as const, {
      message: 'The images endpoint returned no image (no b64_json or url).',
    });
  }
  const mediaType = mediaTypeOf(bytes);
  if (!mediaType) {
    return err('provider_error' as const, {
      message: 'The image model returned neither a PNG nor a JPEG.',
    });
  }
  return ok({ bytes, mediaType, usage: usageOf(parsed.usage) });
}
