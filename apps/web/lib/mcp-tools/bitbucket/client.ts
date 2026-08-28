/**
 * Bitbucket Cloud REST client, over the caller's own delegated grant on
 * the fourth Atlassian app ("Renkei Bitbucket"). Follows the Confluence
 * pattern — each call resolves its own access fresh from the grant,
 * refreshing when near expiry — with one welcome simplification: there is
 * no cloud-id gateway. Everything lives under https://api.bitbucket.org/2.0
 * and descriptions, PR bodies and comments are plain markdown, so nothing
 * here converts formats.
 */

import {
  getGrant,
  refreshGrantTokens,
  ATLASSIAN_BITBUCKET,
  BitbucketAdapter,
  readBitbucketMetadata,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import { getAtlassianBitbucketApp } from '@/lib/atlassian-app';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import { REQUEST_TIMEOUT_MS, isTimeoutError, timeoutSignal } from '../fetch-guard';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';

export interface BitbucketAccess {
  accessToken: string;
  /** The connected account's uuid — Bitbucket's durable identity key. */
  accountId: string;
  /** The connected account's username, for display and for API paths. */
  username: string;
  /**
   * The full `Authorization` header value to send. Production's delegated
   * grant is a Bearer token; a workspace API token (test support) would
   * authenticate with Basic auth instead — carrying the finished header
   * here is what makes that swappable.
   */
  authHeader: string;
}

/** The caller's live Bitbucket token, refreshed when stale. */
export async function resolveBitbucketAccess(
  context: MCPToolContext
): Promise<BitbucketAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', ATLASSIAN_BITBUCKET)
    .where('subject', '=', context.subject)
    .executeTakeFirst();
  if (!row) {
    return 'Bitbucket is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    ATLASSIAN_BITBUCKET,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return 'Could not read the Bitbucket grant.';
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getAtlassianBitbucketApp(context.tenantId, context.origin ?? '');
    if (!app) return 'Bitbucket integration is no longer configured.';
    const refreshed = await refreshGrantTokens(
      new BitbucketAdapter(app.clientSecret),
      context.tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your Bitbucket authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the Bitbucket token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  return {
    accessToken: grant.accessToken,
    accountId: grant.accountId,
    username: readBitbucketMetadata(grant.metadata).username,
    authHeader: `Bearer ${grant.accessToken}`,
  };
}

interface BitbucketLogScope {
  tenantId: string;
  subject?: string;
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * One Bitbucket API call. The Response comes back as-is, ok or not — the
 * shared `describeBitbucketFailure` renders a non-2xx answer for the model;
 * only an unreachable host becomes a local error string here.
 */
export async function bitbucketRequest(
  scope: BitbucketLogScope,
  access: BitbucketAccess,
  pathAndQuery: string,
  init?: {
    method?: string;
    json?: unknown;
    form?: URLSearchParams;
    accept?: string;
  }
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  const jsonBody = init?.json !== undefined ? JSON.stringify(init.json) : undefined;
  const body = jsonBody ?? init?.form;
  let response: Response;
  try {
    response = await fetch(`${BITBUCKET_API_BASE}${pathAndQuery}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: access.authHeader,
        Accept: init?.accept ?? 'application/json',
        ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Bitbucket API unreachable', {
      component: 'bitbucket/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      path: pathAndQuery,
      method: init?.method ?? 'GET',
      timedOut,
    });
    return {
      ok: false,
      error: timedOut
        ? `api.bitbucket.org timed out after ${REQUEST_TIMEOUT_MS}ms`
        : 'Could not reach api.bitbucket.org',
    };
  }
  if (!response.ok) {
    const responseBody = await response.clone().text().catch(() => '');
    logger.warn('Bitbucket API non-OK response', {
      component: 'bitbucket/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      path: pathAndQuery,
      method: init?.method ?? 'GET',
      status: response.status,
      requestBody: jsonBody === undefined ? undefined : secure(truncateForLog(jsonBody)),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
  }
  return { ok: true, response };
}

/**
 * Bitbucket's own error prose, when it sent any — {"error": {"message":
 * "…"}} on most endpoints — else a status-line explanation.
 */
export async function describeBitbucketFailure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const record = rec(body);
  const message = str(rec(record.error).message);
  if (message) return `Bitbucket API ${response.status}: ${message}`;
  if (response.status === 403) {
    return (
      'Bitbucket refused (403) — the consumer likely lacks the needed scope, or your account ' +
      'lacks permission on this repository. An admin can widen the OAuth consumer on ' +
      'bitbucket.org; reconnect afterwards.'
    );
  }
  if (response.status === 429) return 'Bitbucket is rate limiting (429); try again shortly.';
  return `Bitbucket API answered ${response.status}`;
}

// Type-only, to keep the runtime import graph acyclic: bitbucket-auth.ts
// imports this module's functions; this module only names its interface.
import type { BitbucketAuth } from './bitbucket-auth';

/**
 * One JSON call through the injected auth — the shape nearly every tool
 * wants. Non-2xx (local denial or Bitbucket's own answer) becomes the
 * rendered error string.
 */
export async function bbJson(
  auth: BitbucketAuth,
  requiredScopes: readonly string[],
  pathAndQuery: string,
  init?: { method?: string; json?: unknown; form?: URLSearchParams }
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const response = await auth.fetch(requiredScopes, pathAndQuery, init);
  if (!response.ok) return { ok: false, error: await describeBitbucketFailure(response) };
  const text = await response.text().catch(() => '');
  if (!text) return { ok: true, body: {} };
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Malformed Bitbucket API response' };
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed Bitbucket API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

/** One raw-text call — diffs, file contents, step logs. */
export async function bbRawText(
  auth: BitbucketAuth,
  requiredScopes: readonly string[],
  pathAndQuery: string
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const response = await auth.fetch(requiredScopes, pathAndQuery, { accept: '*/*' });
  if (!response.ok) return { ok: false, error: await describeBitbucketFailure(response) };
  return { ok: true, text: await response.text().catch(() => '') };
}

/** Paged listings arrive as {values, next?} — the values, defensively. */
export function values(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.values)
    ? body.values.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}

/** One more page exists — said out loud so a truncated list is never silent. */
export function moreLine(body: Record<string, unknown>, hint: string): string {
  return typeof body.next === 'string' && body.next ? `\n\nMore exist — ${hint}` : '';
}

export function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Counts and ids are numbers, not strings — str() would silently return ''. */
export function num(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

export function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The browser URL for a repository — links the user can actually open. */
export function repoUrl(workspace: string, repoSlug: string): string {
  return `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

export function prUrl(workspace: string, repoSlug: string, id: string | number): string {
  return `${repoUrl(workspace, repoSlug)}/pull-requests/${id}`;
}

export function pipelineUrl(
  workspace: string,
  repoSlug: string,
  buildNumber: string | number
): string {
  return `${repoUrl(workspace, repoSlug)}/pipelines/results/${buildNumber}`;
}
