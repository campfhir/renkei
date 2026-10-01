/**
 * Image generation models — the OpenAI Images API (gpt-image-* on OpenAI
 * itself, and on Azure AI Foundry's v1 surface), spoken with the same
 * base-URL tolerance and credential-header rules as the chat adapter
 * (openai.ts): an Azure host gets Bearer alone, anything else both
 * headers, because Azure's gateway fails a request carrying a pair.
 *
 * These models are not chat models and never go through LlmProvider: one
 * request, one picture back. gpt-image models always answer base64
 * (`b64_json`), which is what this returns — bytes the caller must still
 * treat as untrusted (the chat's image tool runs them through
 * @renkei/document-render before keeping them).
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

export interface ImageModelConfig {
  apiKey: string;
  /** Model id — for Azure AI Foundry, the DEPLOYMENT name. */
  model: string;
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
  signal?: AbortSignal;
}

export interface GeneratedImage {
  /** The image as the provider sent it — untrusted until validated. */
  bytes: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
}

/** An error kind of the chat adapters, plus the provider's safety system saying no. */
export type ImageErrorKind = LlmErrorKind | 'content_filter';

function errorKindOf(status: number, body: string): ImageErrorKind {
  if (/content_?filter|content_policy_violation|moderation_blocked|safety system/i.test(body)) {
    return 'content_filter';
  }
  if (looksLikeCredentialFailure(body)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (status === 529 || status === 502 || status === 503 || status === 504) return 'overloaded';
  return 'provider_error';
}

export async function generateImage(
  config: ImageModelConfig,
  request: ImageRequest
): Promise<Result<GeneratedImage, ImageErrorKind>> {
  // Tolerate a pasted FULL endpoint: the path is appended here.
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/images\/generations$/, '');
  const version = config.apiVersion ? `?api-version=${encodeURIComponent(config.apiVersion)}` : '';
  const format = request.outputFormat ?? 'png';
  const body = {
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

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/images/generations${version}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        ...(isAzureHost(baseUrl) ? {} : { 'api-key': config.apiKey }),
      },
      body: JSON.stringify(body),
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
  const parsed: { data?: unknown; error?: { message?: unknown } } =
    typeof payload === 'object' && payload !== null ? payload : {};
  if (parsed.error) {
    return err(errorKindOf(200, JSON.stringify(parsed.error)), {
      message: String(parsed.error.message ?? 'The images endpoint reported an error.'),
    });
  }
  const first: unknown = Array.isArray(parsed.data) ? parsed.data[0] : undefined;
  const b64: unknown =
    typeof first === 'object' && first !== null ? Reflect.get(first, 'b64_json') : undefined;
  if (typeof b64 !== 'string' || !b64) {
    return err('provider_error' as const, {
      message: 'The images endpoint returned no image (no b64_json).',
    });
  }
  if (b64.length > Math.ceil((RESPONSE_MAX_BYTES * 4) / 3)) {
    return err('provider_error' as const, { message: 'The image is larger than allowed.' });
  }
  return ok({
    bytes: Buffer.from(b64, 'base64'),
    mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
  });
}
