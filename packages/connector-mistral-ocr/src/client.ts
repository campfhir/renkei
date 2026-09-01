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

import type { MistralOcrConfig, MistralOcrError, MistralOcrPage, MistralOcrResult } from './types';

const REQUEST_TIMEOUT_MS = 120_000;

export interface MistralOcrInput {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
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

function buildRequestBody(config: MistralOcrConfig, input: MistralOcrInput): Record<string, unknown> {
  const isPdf = input.contentType === 'application/pdf' || /\.pdf$/i.test(input.filename);
  return {
    model: config.model,
    document: isPdf
      ? { type: 'document_url', document_url: dataUrl(input.bytes, input.contentType) }
      : { type: 'image_url', image_url: dataUrl(input.bytes, input.contentType) },
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
  input: MistralOcrInput
): Promise<{ ok: true; val: MistralOcrResult } | { ok: false; err: MistralOcrError }> {
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
    return { ok: false, err: { type: 'unreachable', message: error instanceof Error ? error.message : String(error) } };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    return { ok: false, err: { type: 'refused', status: response.status, message: bodyText.slice(0, 500) } };
  }

  let parsedJson: unknown;
  try {
    parsedJson = await response.json();
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
