/**
 * The Microsoft Fabric REST API (https://api.fabric.microsoft.com/v1), as
 * plain calls over a fetch the caller supplies — in Renkei that is always
 * the delegate's authenticated fetch on the person's own Fabric grant
 * (`grantFetch({ provider: FABRIC, subject })`), so nothing here sees a
 * token.
 *
 * Two things set Fabric apart from Graph and are handled once, here:
 *
 * - **Long-running operations.** A create, a getDefinition or an
 *   updateDefinition may answer 200/201 with the result, or 202 with an
 *   empty body and three headers: `Location` (the operation's state URL),
 *   `x-ms-operation-id` and `Retry-After` (seconds). The state is polled at
 *   `/operations/{id}` (status NotStarted, Running, Succeeded, Failed,
 *   Undefined) and, once Succeeded, the result is read at
 *   `/operations/{id}/result` — for the operations that have one.
 * - **Definitions are parts.** A notebook's or pipeline's definition is a
 *   list of `{ path, payload, payloadType: 'InlineBase64' }`; decoded here
 *   to text so a reader never handles base64.
 */

import { asRecord, isRecord } from '@renkei/guards';
import type { FabricDefinitionPart, FabricOperationResult } from '@renkei/db';

export const FABRIC_API_BASE = 'https://api.fabric.microsoft.com/v1';

/**
 * The API root a deployment talks to: Fabric's own, or a stand-in
 * (FABRIC_API_BASE_URL) for the browser suite, as ENTRA_DEVELOPER_API_BASE_URL
 * serves the Entra tools. The delegate honours the same variable.
 */
export function fabricApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FABRIC_API_BASE_URL?.trim().replace(/\/+$/, '');
  return configured ? `${configured}/v1` : FABRIC_API_BASE;
}

/** What a Fabric call is made with: a fetch that authenticates as the person. */
export type FabricFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Thrown by a FabricFetch when the request never reached Fabric because
 * Renkei itself refused to send it (the delegate has no grant for the
 * person, or their key is locked) — reported in its own words rather than
 * as Fabric being unreachable or refusing.
 */
export class FabricRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FabricRefusal';
  }
}

/** A started long-running operation: what to poll, and when. */
export interface FabricPending {
  operationId: string;
  retryAfterSeconds: number;
}

export type FabricAnswer =
  | { ok: true; status: number; body: Record<string, unknown>; pending: FabricPending | null }
  /** `status` is Fabric's when it answered; absent when it was unreachable. */
  | { ok: false; status?: number; code: string; error: string; retryAfterSeconds?: number };

const DEFAULT_RETRY_AFTER_SECONDS = 5;
/** Never wait longer than this between polls, whatever Fabric says. */
export const MAX_RETRY_AFTER_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 30_000;

/** `Retry-After` as seconds, within [1, MAX]; the default when absent or unreadable. */
export function retryAfterOf(headers: Headers): number {
  const raw = Number(headers.get('retry-after'));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(Math.round(raw), 1), MAX_RETRY_AFTER_SECONDS);
}

/** The operation a 202 started, from `x-ms-operation-id` or the `Location` path. */
export function pendingOf(response: Response): FabricPending | null {
  if (response.status !== 202) return null;
  const header = response.headers.get('x-ms-operation-id')?.trim();
  const location = response.headers.get('location') ?? '';
  const fromLocation = /\/operations\/([^/?#]+)/.exec(location)?.[1] ?? '';
  const operationId = header || fromLocation;
  return operationId ? { operationId, retryAfterSeconds: retryAfterOf(response.headers) } : null;
}

/** Fabric's own words from its error envelope (`errorCode`, `message`), when it sent one. */
export function fabricReason(body: unknown): { code: string; message: string } {
  const record = asRecord(body);
  // An operation's failure nests the same envelope under `error`.
  const envelope = isRecord(record.error) ? record.error : record;
  const code = typeof envelope.errorCode === 'string' ? envelope.errorCode : '';
  const raw = typeof envelope.message === 'string' ? envelope.message.trim() : '';
  return { code, message: raw.length > 400 ? `${raw.slice(0, 400)}…` : raw };
}

/** What a person should read for a refused or failed call. */
export function describeFabricStatus(status: number, reason: { code: string; message: string }) {
  const why = reason.message ? ` ${reason.message}` : '';
  if (status === 401) {
    return `Fabric refused the connection (401); reconnect Microsoft Fabric on the Connectors page.${why}`;
  }
  if (status === 403) {
    return (
      'Fabric refused (403): either the connection lacks a Fabric permission this needs (or an ' +
      'admin has not consented to it), or your role in the workspace does not allow it — ' +
      `creating, editing and reading definitions need Contributor or above.${why}`
    );
  }
  if (status === 404) return `Not found (404), or not visible to you in Fabric.${why}`;
  if (status === 429) return 'Fabric is rate limiting (429); try again shortly.';
  return `Fabric answered ${status}.${why}`;
}

/**
 * One Fabric call. `pathAndQuery` is relative to /v1 (or a full
 * `continuationUri` Fabric handed back). Empty 2xx bodies come back as `{}`.
 */
export async function fabricRequest(
  fetcher: FabricFetch,
  base: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  pathAndQuery: string,
  body?: unknown
): Promise<FabricAnswer> {
  const url = /^https?:\/\//.test(pathAndQuery) ? pathAndQuery : `${base}${pathAndQuery}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof FabricRefusal) return { ok: false, code: 'Refused', error: error.message };
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      code: timedOut ? 'Timeout' : 'Unreachable',
      error: timedOut
        ? `Fabric did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds` +
          (method === 'GET'
            ? '.'
            : ' — the change may still have gone through; check Fabric before retrying.')
        : 'Could not reach Fabric.',
    };
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the status decides what the caller hears.
  }
  if (!response.ok) {
    const reason = fabricReason(parsed);
    return {
      ok: false,
      status: response.status,
      code: reason.code || `HTTP${response.status}`,
      error: describeFabricStatus(response.status, reason),
      ...(response.status === 429 ? { retryAfterSeconds: retryAfterOf(response.headers) } : {}),
    };
  }
  return {
    ok: true,
    status: response.status,
    body: asRecord(parsed),
    pending: pendingOf(response),
  };
}

/** Every record of a listing (`value`), following `continuationUri` up to `maxPages`. */
export async function fabricPages(
  fetcher: FabricFetch,
  base: string,
  pathAndQuery: string,
  maxPages = 10
): Promise<
  | { ok: true; values: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; status?: number; error: string }
> {
  const values: Record<string, unknown>[] = [];
  let next: string | null = pathAndQuery;
  for (let page = 0; page < maxPages && next; page++) {
    const answer = await fabricRequest(fetcher, base, 'GET', next);
    if (!answer.ok) return answer;
    // Most listings say `value`; the lakehouse tables listing says `data`.
    const list = Array.isArray(answer.body.value) ? answer.body.value : answer.body.data;
    if (Array.isArray(list)) values.push(...list.filter(isRecord));
    const uri = answer.body.continuationUri;
    next = typeof uri === 'string' && uri ? uri : null;
  }
  return { ok: true, values, truncated: next !== null };
}

// ——— long-running operations ———

export type OperationState =
  | { state: 'running'; percentComplete: number | null; retryAfterSeconds: number }
  | { state: 'succeeded'; result: Record<string, unknown> | null }
  | { state: 'failed'; error: string };

/**
 * One look at an operation: its state, and — when it has succeeded and
 * `withResult` — its result. A refused or unreachable look is a running
 * state with a longer wait when it may pass (429, 5xx, unreachable), and a
 * failure when it will not (401, 403, 404).
 */
export async function pollOperation(
  fetcher: FabricFetch,
  base: string,
  operationId: string,
  withResult: boolean
): Promise<OperationState> {
  const id = encodeURIComponent(operationId);
  const answer = await fabricRequest(fetcher, base, 'GET', `/operations/${id}`);
  if (!answer.ok) {
    // Renkei refusing to send (no grant any more) will not pass by waiting.
    const transient =
      answer.code !== 'Refused' &&
      (answer.status === undefined || answer.status === 429 || answer.status >= 500);
    return transient
      ? {
          state: 'running',
          percentComplete: null,
          retryAfterSeconds: answer.retryAfterSeconds ?? MAX_RETRY_AFTER_SECONDS / 2,
        }
      : { state: 'failed', error: answer.error };
  }
  const status = typeof answer.body.status === 'string' ? answer.body.status : '';
  if (status === 'Succeeded') {
    if (!withResult) return { state: 'succeeded', result: null };
    const result = await fabricRequest(fetcher, base, 'GET', `/operations/${id}/result`);
    if (!result.ok)
      return { state: 'failed', error: `The result could not be read: ${result.error}` };
    return { state: 'succeeded', result: result.body };
  }
  if (status === 'Failed') {
    const reason = fabricReason(answer.body);
    return {
      state: 'failed',
      error: reason.message || reason.code || 'Fabric reported the operation failed.',
    };
  }
  const percent = answer.body.percentComplete;
  return {
    state: 'running',
    percentComplete: typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : null,
    retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
  };
}

// ——— definitions ———

/** Total decoded size a definition may have before it is refused, in bytes. */
export const MAX_DEFINITION_BYTES = 4 * 1024 * 1024;

const TEXT_EXTENSIONS = /\.(ipynb|py|scala|r|sql|json|platform|md|txt|yml|yaml)$|^\.platform$/i;

/**
 * A definition answer (`{ definition: { format?, parts: [...] } }`) as
 * decoded parts; a string when it is malformed or too big.
 */
export function decodeDefinition(body: Record<string, unknown>): FabricOperationResult | string {
  const definition = asRecord(body.definition);
  if (!Array.isArray(definition.parts)) return 'Fabric answered without a definition.';
  let total = 0;
  const parts: FabricDefinitionPart[] = [];
  for (const raw of definition.parts) {
    const part = asRecord(raw);
    const path = typeof part.path === 'string' ? part.path : '';
    const payload = typeof part.payload === 'string' ? part.payload : '';
    if (!path) continue;
    const bytes = Buffer.from(payload, 'base64');
    total += bytes.length;
    if (total > MAX_DEFINITION_BYTES) {
      return `The definition is larger than ${MAX_DEFINITION_BYTES / 1024 / 1024} MB; open it in Fabric instead.`;
    }
    const name = path.split('/').pop() ?? path;
    parts.push(
      TEXT_EXTENSIONS.test(name)
        ? { path, text: bytes.toString('utf8') }
        : { path, base64: payload }
    );
  }
  return { format: typeof definition.format === 'string' ? definition.format : null, parts };
}

/** Parts as Fabric's create and updateDefinition bodies take them. */
export function encodeDefinition(
  parts: { path: string; text: string }[],
  format?: string
): Record<string, unknown> {
  return {
    ...(format ? { format } : {}),
    parts: parts.map((part) => ({
      path: part.path,
      payload: Buffer.from(part.text, 'utf8').toString('base64'),
      payloadType: 'InlineBase64',
    })),
  };
}

/** The part a reader opens first: the notebook or pipeline content, not `.platform`. */
export function mainPart(result: FabricOperationResult): FabricDefinitionPart | null {
  return (
    result.parts.find((part) => /^(notebook-content|pipeline-content)\./.test(part.path)) ??
    result.parts.find((part) => part.path !== '.platform') ??
    null
  );
}
