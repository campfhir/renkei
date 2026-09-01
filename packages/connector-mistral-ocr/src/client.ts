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
 * This is built against Mistral's own public OCR API contract
 * (`POST /v1/ocr` on api.mistral.ai: `{model, document: {type, ...}}` →
 * `{pages: [{index, markdown, ...}], usage_info: {pages_processed}}`),
 * since no Foundry-specific sample code was available while writing this.
 * Azure AI Foundry model deployments sometimes proxy a third-party model's
 * native API verbatim and sometimes wrap it differently — check the
 * "Sample inference code" tab for this deployment in the Foundry portal
 * and adjust `buildRequestBody`/`parseResponse`/the auth header below if
 * it differs. Everything specific to the wire contract is isolated to
 * those three spots on purpose, so a mismatch is a small, local fix.
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
