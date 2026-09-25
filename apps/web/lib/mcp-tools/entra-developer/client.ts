/**
 * Microsoft Graph access for the entra_ tools, over the caller's own
 * delegated grant on the Entra Developer app registration — the SECOND
 * Entra app (lib/entra-developer-app.ts), on its own grant provider
 * (ENTRA_DEVELOPER), so nothing here ever reads the Microsoft 365 grant.
 *
 * The graph/client.ts pattern: access is resolved fresh on every call,
 * refreshing near expiry, never captured in a handler closure. The request
 * wrapper is this module's own rather than graph/client.ts's because a
 * developer provisioning an application needs Graph's REASON — "Another
 * object with the same value for property identifierUris already exists",
 * "Insufficient privileges to complete the operation" — not just the
 * status, and the 403 wording has to name this connection, not Microsoft
 * 365.
 */

import { GRAPH_BASE_URL } from '@renkei/connector-microsoft';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  getGrant,
  refreshGrantTokens,
  ENTRA_DEVELOPER,
  MicrosoftAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { getDatabase } from '@renkei/db';
import { getEntraDeveloperApp } from '@/lib/entra-developer-app';
import { logger, secure } from '@/lib/logger';
import { REQUEST_TIMEOUT_MS, isTimeoutError, timeoutSignal } from '../fetch-guard';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * Graph, less the path. A deployment may point it elsewhere
 * (ENTRA_DEVELOPER_API_BASE_URL) the way JIRA_ADMIN_API_BASE_URL serves a
 * stand-in site to the browser suite.
 */
const API_BASE = process.env.ENTRA_DEVELOPER_API_BASE_URL?.replace(/\/+$/, '') || GRAPH_BASE_URL;

export interface EntraAccess {
  accessToken: string;
  /** The Microsoft account whose grant this token came from (its oid). */
  accountId: string;
  /** The person's user principal name, for "connected as". */
  upn: string;
  /** The directory the grant was minted in. */
  tenantId: string;
}

/** What the request wrapper needs of its caller — an MCPToolContext satisfies it. */
export interface EntraCallContext {
  tenantId: string;
  subject?: string;
  origin?: string;
}

/**
 * The caller's live Entra Developer token, refreshed when stale. A string
 * is a human-readable reason there is none, handed straight to the model.
 */
export async function resolveEntraAccess(context: EntraCallContext): Promise<EntraAccess | string> {
  if (!context.subject) return 'No signed-in identity on this request.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Token encryption is not configured on this deployment.';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', ENTRA_DEVELOPER)
    .where('subject', '=', context.subject)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return (
      'Entra Developer is not connected. Connect it on the Connectors page (it is separate ' +
      'from Microsoft 365), then try again.'
    );
  }

  const grantResult = await getGrant(
    ENTRA_DEVELOPER,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) {
    return 'Your Entra Developer connection could not be read. Reconnect on the Connectors page.';
  }
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getEntraDeveloperApp(context.tenantId, context.origin ?? '');
    if (!app) return 'Entra Developer is no longer configured for this organization.';
    const tid =
      typeof grant.metadata.tid === 'string' && grant.metadata.tid
        ? grant.metadata.tid
        : app.directoryTenantId;
    const refreshed = await refreshGrantTokens(
      new MicrosoftAdapter(app.clientSecret, tid, ENTRA_DEVELOPER),
      context.tenantId,
      row.provider_account_id,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your Entra Developer authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the Entra Developer token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  return {
    accessToken: grant.accessToken,
    accountId: row.provider_account_id,
    upn: typeof grant.metadata.upn === 'string' ? grant.metadata.upn : '',
    tenantId: typeof grant.metadata.tid === 'string' ? grant.metadata.tid : '',
  };
}

export type EntraResult =
  | { ok: true; body: Record<string, unknown> }
  /** `status` is Graph's answer when there was one; absent when Graph was unreachable. */
  | { ok: false; error: string; status?: number };

/** Graph's own reason from its error envelope, when it carries one. */
function graphReason(body: unknown): string {
  const error = rec(rec(body).error);
  const message = str(error.message).trim();
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}

function describeStatus(status: number, reason: string): string {
  const why = reason ? ` ${reason}` : '';
  if (status === 401) {
    return `Graph refused the Entra Developer token (401); reconnect it on the Connectors page.${why}`;
  }
  if (status === 403) {
    return (
      'Graph refused (403): either the Entra Developer app registration lacks a delegated ' +
      'permission this call needs (or an admin has not consented to it), or Entra does not let ' +
      'this account do this — creating applications may be restricted to admins, and changing ' +
      `one needs to own it. entra_check_access shows what the connection holds.${why}`
    );
  }
  if (status === 404) return `Not found (404), or not visible to the connected account.${why}`;
  if (status === 429) return 'Graph is rate limiting (429); try again shortly.';
  return `Microsoft Graph answered ${status}.${why}`;
}

function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * One Graph call. `pathAndQuery` is relative to the v1.0 root, or a full
 * `@odata.nextLink`. Empty answers (201 without a body, 204) come back as
 * `{}`; anything non-JSON with a 2xx does too.
 */
export async function entraRequest(
  context: EntraCallContext,
  access: EntraAccess,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  pathAndQuery: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<EntraResult> {
  const url = pathAndQuery.startsWith('https://') ? pathAndQuery : `${API_BASE}${pathAndQuery}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Graph API unreachable', {
      component: 'entra-developer/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      method,
      path: pathAndQuery,
      timedOut,
    });
    const reason = timedOut
      ? `graph.microsoft.com timed out after ${REQUEST_TIMEOUT_MS}ms`
      : 'Could not reach graph.microsoft.com';
    return {
      ok: false,
      // A write that timed out may still have landed; say so rather than
      // implying nothing happened.
      error:
        method === 'GET' || !timedOut
          ? reason
          : `${reason} — the change may still have gone through; check Entra before retrying.`,
    };
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — the status decides what the caller hears.
  }
  if (!response.ok) {
    logger.warn('Graph API non-OK response', {
      component: 'entra-developer/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      method,
      path: pathAndQuery,
      status: response.status,
      responseBody: text ? secure(truncateForLog(text)) : undefined,
    });
    return {
      ok: false,
      error: describeStatus(response.status, graphReason(parsed)),
      status: response.status,
    };
  }
  return { ok: true, body: rec(parsed) };
}

export const entraGet = (
  context: EntraCallContext,
  access: EntraAccess,
  path: string,
  headers?: Record<string, string>
): Promise<EntraResult> => entraRequest(context, access, 'GET', path, undefined, headers);

/**
 * Every record of a `value` listing, following `@odata.nextLink` until
 * Graph stops — `truncated` when there were more than `maxPages` pages, so
 * a caller can say "and more" rather than pretend it saw all.
 */
export async function entraPages(
  context: EntraCallContext,
  access: EntraAccess,
  pathAndQuery: string,
  headers?: Record<string, string>,
  maxPages = 10
): Promise<
  | { ok: true; values: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; error: string; status?: number }
> {
  const collected: Record<string, unknown>[] = [];
  let next: string | null = pathAndQuery;
  for (let page = 0; page < maxPages && next; page++) {
    const result = await entraGet(context, access, next, headers);
    if (!result.ok) return result;
    collected.push(...values(result.body));
    const link = result.body['@odata.nextLink'];
    next = typeof link === 'string' && link ? link : null;
  }
  return { ok: true, values: collected, truncated: next !== null };
}

// ——— shared shaping helpers ———

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

export function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

export function recs(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item)
      )
    : [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The `value` array of a Graph listing. */
export function values(body: Record<string, unknown>): Record<string, unknown>[] {
  return recs(body.value);
}

/** A string literal inside an OData `$filter` — single quotes doubled. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A `$search` clause — Graph rejects a quote of the caller's own inside it. */
export function searchClause(field: string, term: string): string {
  return `"${field}:${term.replace(/"/g, '').trim()}"`;
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (value: string): boolean => GUID.test(value);

/** `$search` and `$count` against directory objects need the eventual-consistency header. */
export const EVENTUAL = { ConsistencyLevel: 'eventual' };
