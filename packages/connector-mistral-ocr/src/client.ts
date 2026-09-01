/**
 * The OCR call itself — one document per call, whole (even multi-page), to
 * Mistral Document AI (OCR 4) on Microsoft Foundry. Mistral bills per PAGE
 * and pitches this as "optimized for high-throughput batch document
 * processing," which is the tell that the model paginates internally: the
 * caller sends one file and gets back one entry per page, not the other
 * way around. That's what shapes the document-ocr-pipeline batch kind —
 * one call per source FILE, never a manual pre-split into page images.
 *
 * *** VERIFY BEFORE PRODUCTION USE ***
 * This targets Mistral's own public OCR API contract
 * (`POST /v1/ocr` on api.mistral.ai: `{model, document: {type, ...}}` →
 * `{pages: [{index, markdown, ...}], usage_info: {pages_processed}}`).
 * Confirmed (not just assumed) that Foundry proxies this model's native API
 * rather than wrapping it in the chat-completions shape: Microsoft's own
 * guidance for Mistral Document AI on Foundry says not to append
 * `/v1/chat/completions` to the dashboard's Target URI, and that the native
 * `@mistralai/mistralai` SDK works against a Foundry deployment by simply
 * pointing its `serverURL` at the Azure endpoint — which only works if the
 * wire shape matches Mistral's own. So `config.endpoint` should be the
 * dashboard's Target URI with `/v1/ocr` appended (e.g.
 * `https://<resource>.services.ai.azure.com/v1/ocr`), and this file's
 * request/response shape should already be correct. Still worth checking
 * the "Sample inference code" tab in the Foundry portal for this specific
 * deployment before production use — Foundry's per-model proxying has been
 * known to vary — and adjust `buildRequestBody`/`parseResponse`/the auth
 * header below if it differs. Everything specific to the wire contract is
 * isolated to those three spots on purpose, so a mismatch is a small,
 * local fix.
 *
 * The Azure-hosted schema also rejects Mistral-native-only request fields
 * (e.g. `confidence_scores_granularity`) with a 422 unless the request
 * carries `extra-parameters: pass-through`, telling the Azure gateway to
 * forward unrecognized fields through instead of validating them strictly.
 * `buildRequestBody` doesn't send any such fields today, but the header
 * costs nothing to always include and avoids a confusing 422 the moment
 * one is added.
 */

import { secure } from '@campfhir/bored-logs';
import type { MistralOcrConfig, MistralOcrError, MistralOcrPage, MistralOcrResult } from './types';

const REQUEST_TIMEOUT_MS = 120_000;

/** How much of a raw response body a debug log line keeps — bounded, since a
 *  successful OCR response's markdown can be sizeable and this exists to show
 *  the SHAPE of what Foundry sent back, not to capture the full extracted
 *  text. */
const DEBUG_BODY_PREVIEW_CHARS = 4_000;

/**
 * The structural slice of a bored-logs logger this package needs — the
 * `LoopLogger`/`EventLoopDeps.logger` shape every app already builds
 * (`apps/web/lib/logger.ts`, `apps/worker/src/logger.ts`, ...). Declared
 * locally (not imported from `@campfhir/bored-logs`) so this package never
 * needs to CONSTRUCT a logger of its own — no adapters, no app-specific
 * identity — callers always pass their own app's real logger in, so its
 * adapters (ConsoleAdapter's `maskSecure`, a PostgresAdapter's encryption)
 * are the ones actually enforcing what `secure()`/`redact()` mean below.
 */
export interface MistralOcrLogger {
  debug(message: string, attrs?: Record<string, unknown>): void;
}

export interface MistralOcrInput {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface MistralOcrCallOptions {
  /**
   * Enables debug logging of the request (endpoint, model, document type,
   * byte size, and the API key wrapped in bored-logs' `secure()` — masked
   * to `[secure]` wherever the attached adapter has `maskSecure` on, which
   * every app here sets from NODE_ENV=production) and the response (status,
   * a bounded preview of the raw body — NOT wrapped in `redact()`: doing so
   * would mask it identically to `secure()` under the same maskSecure rule,
   * hiding it from exactly the console output this option exists to show).
   * Document bytes themselves are never logged either way. Off by default;
   * pass the caller's own app logger and set CONSOLE_LOG_LEVEL=debug (or
   * LOG_DB_LEVEL=debug for the persisted copy) to see it.
   */
  logger?: MistralOcrLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Bytes as a data: URL — Mistral's OCR API accepts an inline document this way. */
function dataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** 'document_url' for a PDF, 'image_url' otherwise — shared by the request builder and the debug log line so they can never disagree. */
function documentTypeFor(input: MistralOcrInput): 'document_url' | 'image_url' {
  const isPdf = input.contentType === 'application/pdf' || /\.pdf$/i.test(input.filename);
  return isPdf ? 'document_url' : 'image_url';
}

function buildRequestBody(config: MistralOcrConfig, input: MistralOcrInput): Record<string, unknown> {
  const type = documentTypeFor(input);
  const url = dataUrl(input.bytes, input.contentType);
  return {
    model: config.model,
    document: type === 'document_url' ? { type, document_url: url } : { type, image_url: url },
  };
}

function parseResponse(body: unknown): { ok: true; val: MistralOcrResult } | { ok: false; message: string } {
  if (!isRecord(body) || !Array.isArray(body.pages)) {
    return { ok: false, message: 'answered no pages array' };
  }
  const pages: MistralOcrPage[] = [];
  for (const raw of body.pages) {
    if (!isRecord(raw) || typeof raw.index !== 'number' || typeof raw.markdown !== 'string') {
      return { ok: false, message: 'a page entry was missing index/markdown' };
    }
    pages.push({ index: raw.index, markdown: raw.markdown });
  }
  const usage = isRecord(body.usage_info) ? body.usage_info : {};
  const pagesProcessed = typeof usage.pages_processed === 'number' ? usage.pages_processed : pages.length;
  return { ok: true, val: { pages, pagesProcessed } };
}

export async function callMistralOcr(
  config: MistralOcrConfig,
  input: MistralOcrInput,
  options: MistralOcrCallOptions = {}
): Promise<{ ok: true; val: MistralOcrResult } | { ok: false; err: MistralOcrError }> {
  const log = options.logger;
  const component = 'connector-mistral-ocr';
  const documentType = documentTypeFor(input);

  log?.debug('mistral ocr request POST {endpoint}', {
    component,
    endpoint: config.endpoint,
    model: config.model,
    documentType,
    filename: input.filename,
    contentType: input.contentType,
    bytesLength: input.bytes.byteLength,
    // secure(): masked to `[secure]` by any adapter with maskSecure on
    // (every app here sets that from NODE_ENV=production, baked into every
    // Docker stage) — the codebase's own mechanism, not a bespoke
    // placeholder, so it degrades the same way every other secret in these
    // logs does rather than needing its own one-off rule.
    headers: {
      authorization: secure(`Bearer ${config.apiKey}`),
      'content-type': 'application/json',
      'extra-parameters': 'pass-through',
    },
  });

  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        // Most Azure AI Foundry serverless deployments accept a bearer
        // token here; some model-as-a-service resources expect `api-key`
        // instead — see this file's header comment.
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        // Tells the Azure gateway to forward request fields it doesn't
        // recognize straight to the model instead of rejecting them with a
        // 422 — see this file's header comment.
        'extra-parameters': 'pass-through',
      },
      body: JSON.stringify(buildRequestBody(config, input)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.debug('mistral ocr request failed: {error}', { component, error: message });
    return { ok: false, err: { type: 'unreachable', message } };
  }

  // Read the raw bytes once, up front — .json() consumes the body stream and
  // gives no access to it on a parse failure, and the debug log wants the
  // raw shape on every path (success, refusal, or malformed body) rather
  // than duplicating a fallback into each branch. Decoded as UTF-8 text
  // strictly (fatal: true) rather than via response.text() (which silently
  // replaces bad bytes with U+FFFD) so a genuinely binary or wrongly-encoded
  // body is DETECTED as such — "empty preview" then means the body really
  // was empty, not that decoding quietly ate it.
  const bodyBytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  let bodyText: string;
  try {
    bodyText = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
  } catch {
    bodyText = '';
  }
  log?.debug('mistral ocr response {status}', {
    component,
    status: response.status,
    ok: response.ok,
    bodyBytesLength: bodyBytes.byteLength,
    // Stringified so an empty/absent body is unambiguous ("" vs a value
    // that failed to render) and any embedded braces/newlines can't be
    // misread as separate attrs by anyone eyeballing the raw log line.
    bodyPreview: JSON.stringify(bodyText.slice(0, DEBUG_BODY_PREVIEW_CHARS)),
    // Only when there ARE bytes but they didn't decode as UTF-8 text (bad
    // encoding, or genuinely binary) — the raw bytes, so nothing is lost to
    // a failed decode.
    ...(bodyText === '' && bodyBytes.byteLength > 0
      ? { bodyBase64: Buffer.from(bodyBytes).toString('base64').slice(0, DEBUG_BODY_PREVIEW_CHARS) }
      : {}),
  });

  if (!response.ok) {
    return { ok: false, err: { type: 'refused', status: response.status, message: bodyText.slice(0, 500) } };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    return { ok: false, err: { type: 'malformed', message: 'response was not valid JSON' } };
  }
  const parsed = parseResponse(parsedJson);
  if (!parsed.ok) return { ok: false, err: { type: 'malformed', message: parsed.message } };
  return { ok: true, val: parsed.val };
}

// Re-exported for callers building error messages without importing types.ts too.
export function describeMistralOcrError(error: MistralOcrError): string {
  switch (error.type) {
    case 'unconfigured':
      return 'The Mistral OCR connector is not configured for this org.';
    case 'unreachable':
      return `Could not reach the Mistral OCR endpoint: ${error.message}`;
    case 'refused':
      return `The Mistral OCR endpoint refused the request (${error.status}): ${str(error.message)}`;
    case 'malformed':
      return `The Mistral OCR endpoint answered an unexpected shape: ${error.message}`;
    default:
      return 'Unknown Mistral OCR error.';
  }
}
