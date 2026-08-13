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
 * by which point the access token has expired.
 */

import { GRAPH_BASE_URL } from '@renkei/connector-microsoft';
import { parseEncryptionKey } from '@renkei/crypto';
import { getGrant, refreshGrantTokens, MICROSOFT, MicrosoftAdapter } from '@renkei/provider-grants';
import { getDatabase } from '@renkei/db';
import { getMicrosoftApp } from '@/lib/microsoft-app';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';

/** Refresh inside this window of expiry rather than risking a 401 mid-call. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface GraphAccess {
  accessToken: string;
  upn: string | null;
}

export type GraphResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

export function describeStatus(status: number): string {
  if (status === 403) {
    return (
      'Graph refused (403) — the grant likely lacks the needed scope, or the Entra app is ' +
      'missing the delegated permission. Reconnect Microsoft after the admin fixes the app.'
    );
  }
  if (status === 404) return 'Not found (404) — it may have been moved, renamed or deleted.';
  if (status === 423) return 'The file is checked out or locked by someone else (423).';
  if (status === 429) return 'Graph is rate limiting (429); try again shortly.';
  if (status === 507) return 'The drive is out of storage (507).';
  return `Microsoft Graph answered ${status}`;
}

function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * The calling user's Graph token. Returns a human-readable string on failure
 * so a handler can hand it straight back to the model.
 */
export async function resolveGraphAccess(context: MCPToolContext): Promise<GraphAccess | string> {
  if (!context.subject) return 'No signed-in identity on this request.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Token encryption is not configured on this deployment.';

  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', MICROSOFT)
    .where('subject', '=', context.subject)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return 'Microsoft is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    MICROSOFT,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) {
    return 'Your Microsoft connection could not be read. Reconnect on the Connectors page.';
  }
  let grant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getMicrosoftApp(context.tenantId, context.origin ?? '');
    if (!app) return 'The Microsoft connector is not configured for this organization.';
    const tid =
      typeof grant.metadata.tid === 'string' && grant.metadata.tid
        ? grant.metadata.tid
        : app.directoryTenantId;
    if (!tid) return 'The Microsoft connector has no directory tenant id configured.';

    const refreshed = await refreshGrantTokens(
      new MicrosoftAdapter(app.clientSecret, tid),
      context.tenantId,
      row.provider_account_id,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your Microsoft connection was revoked. Reconnect on the Connectors page.'
        : 'Could not refresh your Microsoft token. Reconnect on the Connectors page.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  return {
    accessToken: grant.accessToken,
    upn: typeof grant.metadata.upn === 'string' ? grant.metadata.upn : null,
  };
}

async function graphCall(
  context: MCPToolContext,
  accessToken: string,
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
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  } catch {
    logger.warn('Graph API unreachable', {
      component: 'graph/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
    });
    return { ok: false, error: 'Could not reach graph.microsoft.com' };
  }

  const responseBody = await response.text().catch(() => '');
  if (!response.ok) {
    logger.warn('Graph API non-OK response', {
      component: 'graph/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      status: response.status,
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status) };
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
  context: MCPToolContext,
  token: string,
  path: string,
  headers?: Record<string, string>
): Promise<GraphResult> => graphCall(context, token, 'GET', path, undefined, headers);

export const graphPost = (
  context: MCPToolContext,
  token: string,
  path: string,
  json: unknown,
  headers?: Record<string, string>
): Promise<GraphResult> => graphCall(context, token, 'POST', path, json, headers);

export const graphPatch = (
  context: MCPToolContext,
  token: string,
  path: string,
  json: unknown
): Promise<GraphResult> => graphCall(context, token, 'PATCH', path, json);

export const graphPut = (
  context: MCPToolContext,
  token: string,
  path: string,
  json: unknown
): Promise<GraphResult> => graphCall(context, token, 'PUT', path, json);

export const graphDelete = (
  context: MCPToolContext,
  token: string,
  path: string
): Promise<GraphResult> => graphCall(context, token, 'DELETE', path);

/** Upload raw bytes; Graph wants the body unwrapped, not JSON. */
export async function graphPutContent(
  context: MCPToolContext,
  accessToken: string,
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
    response = await fetch(`${GRAPH_BASE_URL}${pathAndQuery}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType },
      body,
    });
  } catch {
    return { ok: false, error: 'Could not reach graph.microsoft.com' };
  }
  const responseBody = await response.text().catch(() => '');
  if (!response.ok) {
    logger.warn('Graph upload failed', {
      component: 'graph/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      status: response.status,
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status) };
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
