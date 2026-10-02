/**
 * Microsoft Graph access for the SharePoint and OneDrive tool namespaces.
 *
 * The shape follows outlook/index.ts's private helpers rather than
 * @renkei/connector-microsoft's graphRequest: MCP tools return human-readable
 * error strings to an LLM, not Result types, and they log with the request
 * context attached. Outlook is NOT migrated onto this in the same change —
 * it is 3000 lines with three test files pinned to its internals, and that is
 * a separate, test-covered move.
 *
 * Access is resolved fresh on every call, never captured in a handler
 * closure: a tool registered at connect time may be invoked an hour later,
 * by which point the grant may have been revoked or reconnected.
 *
 * No token is read here (docs/delegate-key-design.md, "Phase 1 as built"):
 * the delegate worker holds the Microsoft grant, and what a caller gets is
 * an `AuthedFetch` that the delegate authenticates, refreshes and retries
 * once on a 401. The web process never sees an access token.
 */

import {
  GRAPH_BASE_URL,
  GateTimeoutError,
  graphFetch,
  headersForLog,
  retryAfterSeconds,
} from '@renkei/connector-microsoft';
import { MICROSOFT } from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { grantRefusalText, refusalTextOf } from '@/lib/grant-refusals';
import { logger, secure } from '@/lib/logger';
import { REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, isTimeoutError } from '../fetch-guard';

const LABEL = 'Microsoft';
/**
 * All these calls need of their caller.
 *
 * Narrower than MCPToolContext, which an MCPToolContext satisfies
 * structurally, so the tools pass themselves unchanged — and a plain web
 * route can call Graph without inventing an Atlassian access token, a cloud
 * id and a JQL limit it has no use for. The connectors page manages the same
 * watches the MCP tools do, so it needs the same client, not a second one.
 */
export interface GraphCallContext {
  tenantId: string;
  /** The caller's OIDC subject — whose grant is used. */
  subject?: string;
  /**
   * Public origin. No longer needed to reach Graph (the delegate refreshes
   * the grant itself), but an MCPToolContext carries it and callers still
   * pass it, so it stays accepted.
   */
  origin?: string;
}

export interface GraphAccess {
  /** `fetch` on the caller's own Microsoft grant; the delegate supplies the credential. */
  auth: AuthedFetch;
  upn: string | null;
  /**
   * The Microsoft account whose grant `auth` rides on. A content watch
   * records it so the worker knows which grant to poll with, and getting it
   * from the same lookup that produced the fetcher is what keeps the two
   * from disagreeing.
   */
  accountId: string;
}

export type GraphResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

export function describeStatus(status: number, retryAfter: number | null = null): string {
  const wait = retryAfter !== null ? ` Microsoft asks for a ${retryAfter}s pause first.` : '';
  if (status === 403) {
    return (
      'Graph refused (403) — the grant likely lacks the needed scope, or the Entra app is ' +
      'missing the delegated permission. Reconnect Microsoft after the admin fixes the app.'
    );
  }
  if (status === 404) return 'Not found (404) — it may have been moved, renamed or deleted.';
  if (status === 423) return 'The file is checked out or locked by someone else (423).';
  if (status === 429) return `Graph is rate limiting (429); try again shortly.${wait}`;
  if (status === 503) return `Graph is temporarily unavailable (503); try again shortly.${wait}`;
  if (status === 507) return 'The drive is out of storage (507).';
  return `Microsoft Graph answered ${status}`;
}

/** The sentence for a request that never got an answer. */
function describeFetchFailure(error: unknown, timeoutMs: number): string {
  if (isTimeoutError(error)) return `graph.microsoft.com timed out after ${timeoutMs}ms`;
  if (error instanceof GateTimeoutError) {
    return 'The mailbox is busy with other Renkei requests; try again in a moment.';
  }
  return 'Could not reach graph.microsoft.com';
}

function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * The calling user's Graph access: a fetcher on their Microsoft grant plus
 * what the grant recorded about them. Returns a human-readable string on
 * failure so a handler can hand it straight back to the model.
 */
export async function resolveGraphAccess(context: GraphCallContext): Promise<GraphAccess | string> {
  if (!context.subject) return 'No signed-in identity on this request.';

  const grant = { tenantId: context.tenantId, provider: MICROSOFT, subject: context.subject };
  const described = await delegateGrants().describe(grant);
  if (!described.ok) return grantRefusalText(described.err.type, LABEL);

  return {
    auth: grantFetch(grant),
    upn: typeof described.val.metadata.upn === 'string' ? described.val.metadata.upn : null,
    accountId: described.val.accountId,
  };
}

async function graphCall(
  context: GraphCallContext,
  auth: AuthedFetch,
  method: string,
  pathAndQuery: string,
  json?: unknown,
  extraHeaders?: Record<string, string>
): Promise<GraphResult> {
  const url = pathAndQuery.startsWith('https://')
    ? pathAndQuery
    : `${GRAPH_BASE_URL}${pathAndQuery}`;
  let response: Response;
  try {
    response = await graphFetch(auth, url, {
      method,
      headers: {
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      lane: 'interactive',
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    logger.warn('Graph API unreachable', {
      component: 'graph/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      timedOut: isTimeoutError(error),
      mailboxBusy: error instanceof GateTimeoutError,
    });
    return { ok: false, error: describeFetchFailure(error, REQUEST_TIMEOUT_MS) };
  }

  // The delegate answering for itself (no grant, revoked, refresh failed)
  // is not a Graph status, and the status words would mislead.
  const refused = refusalTextOf(response, LABEL);
  if (refused) return { ok: false, error: refused };

  const responseBody = await response.text().catch(() => '');
  if (!response.ok) {
    logger.warn('Graph API non-OK response', {
      component: 'graph/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      method,
      status: response.status,
      responseHeaders: headersForLog(response.headers),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return {
      ok: false,
      error: describeStatus(response.status, retryAfterSeconds(response.headers)),
    };
  }

  // 202 (accepted, e.g. copy) and 204 (deleted) carry no body.
  if (!responseBody) return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { ok: false, error: 'Malformed Graph API response' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Malformed Graph API response' };
  }
  return { ok: true, body: { ...parsed } };
}

export const graphGet = (
  context: GraphCallContext,
  auth: AuthedFetch,
  path: string,
  headers?: Record<string, string>
): Promise<GraphResult> => graphCall(context, auth, 'GET', path, undefined, headers);

export const graphPost = (
  context: GraphCallContext,
  auth: AuthedFetch,
  path: string,
  json: unknown,
  headers?: Record<string, string>
): Promise<GraphResult> => graphCall(context, auth, 'POST', path, json, headers);

export const graphPatch = (
  context: GraphCallContext,
  auth: AuthedFetch,
  path: string,
  json: unknown
): Promise<GraphResult> => graphCall(context, auth, 'PATCH', path, json);

export const graphPut = (
  context: GraphCallContext,
  auth: AuthedFetch,
  path: string,
  json: unknown
): Promise<GraphResult> => graphCall(context, auth, 'PUT', path, json);

export const graphDelete = (
  context: GraphCallContext,
  auth: AuthedFetch,
  path: string
): Promise<GraphResult> => graphCall(context, auth, 'DELETE', path);

/** Upload raw bytes; Graph wants the body unwrapped, not JSON. */
export async function graphPutContent(
  context: GraphCallContext,
  auth: AuthedFetch,
  pathAndQuery: string,
  bytes: Uint8Array,
  contentType: string
): Promise<GraphResult> {
  // Copy into a view with a plain ArrayBuffer behind it. Passing `bytes`
  // straight through fails to typecheck (a Uint8Array may be backed by a
  // SharedArrayBuffer), and passing `bytes.buffer` would upload the whole
  // backing buffer — trailing garbage included — whenever the array is a
  // view into something larger. Uploads are size-capped, so the copy is cheap.
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);

  let response: Response;
  try {
    response = await graphFetch(auth, pathAndQuery, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
      lane: 'interactive',
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: describeFetchFailure(error, UPLOAD_TIMEOUT_MS) };
  }
  const refused = refusalTextOf(response, LABEL);
  if (refused) return { ok: false, error: refused };
  const responseBody = await response.text().catch(() => '');
  if (!response.ok) {
    logger.warn('Graph upload failed', {
      component: 'graph/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      status: response.status,
      responseHeaders: headersForLog(response.headers),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return {
      ok: false,
      error: describeStatus(response.status, retryAfterSeconds(response.headers)),
    };
  }
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, body: { ...parsed } };
    }
  } catch {
    // An empty or non-JSON 200 is still a successful upload.
  }
  return { ok: true, body: {} };
}

/**
 * The pre-authenticated download URL for a file, via `GET …/content` with the
 * 302 caught by hand instead of followed. Graph sometimes omits the
 * `@microsoft.graph.downloadUrl` annotation from item metadata — seen on
 * items shared from another drive — while /content still redirects fine, so
 * this is the fallback when the annotation is missing (the same dual path
 * @renkei/connector-microsoft's graphDownload takes to fetch bytes).
 */
export async function graphContentDownloadUrl(
  context: GraphCallContext,
  auth: AuthedFetch,
  driveId: string,
  itemId: string
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const path = `/drives/${driveId}/items/${itemId}/content`;
  let response: Response;
  try {
    // `redirect: 'manual'` reaches the delegate, which hands the 302 back
    // untouched instead of following it.
    response = await graphFetch(auth, path, {
      redirect: 'manual',
      lane: 'interactive',
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: describeFetchFailure(error, REQUEST_TIMEOUT_MS) };
  }
  const refused = refusalTextOf(response, LABEL);
  if (refused) return { ok: false, error: refused };
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) {
    return { ok: true, url: location };
  }
  logger.warn('Graph /content offered no redirect', {
    component: 'graph/fetch',
    tenantId: context.tenantId,
    subject: context.subject,
    path,
    status: response.status,
    responseHeaders: headersForLog(response.headers),
  });
  return {
    ok: false,
    error: response.ok
      ? 'Graph offered no download redirect for this file.'
      : describeStatus(response.status),
  };
}

// ——— shared shaping helpers ———

export function values(body: Record<string, unknown>): Record<string, unknown>[] {
  const list = body.value;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  );
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

export function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

export function errText(text: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Human byte size for listings. */
export function byteSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
