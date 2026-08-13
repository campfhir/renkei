/**
 * Confluence Cloud REST client, over the caller's own delegated grant on
 * the third Atlassian app ("Renkei Confluence"). Follows the Outlook/
 * WebEx/Zoom pattern, not the Jira/JSM one: Confluence is a different
 * product with its own gateway path
 * (api.atlassian.com/ex/confluence/{cloudId}/wiki/...), so there's no
 * benefit to reusing Jira's apiBaseUrl/accessToken context-swap trick —
 * each tool call resolves its own access fresh from the grant, refreshing
 * when near expiry.
 *
 * Confluence's v2 REST API (`/wiki/api/v2/...`) is the intended target,
 * but has real gaps a new integration has to route around: no v2 search,
 * no v2 attachment upload, unreliable v2 drafts/move. Both API versions
 * live under the same `/wiki` gateway prefix, so `confluenceGet`/etc. take
 * the full sub-path (`/api/v2/pages` or `/rest/api/search`) rather than
 * having two separate client instances.
 */

import {
  getGrant,
  refreshGrantTokens,
  ATLASSIAN_CONFLUENCE,
  AtlassianAdapter,
  readAtlassianMetadata,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import { getAtlassianConfluenceApp } from '@/lib/atlassian-app';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface ConfluenceAccess {
  accessToken: string;
  cloudId: string;
  accountId: string;
}

/** The caller's live Confluence token + cloud id, refreshed when stale. */
export async function resolveConfluenceAccess(
  context: MCPToolContext
): Promise<ConfluenceAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', ATLASSIAN_CONFLUENCE)
    .where('subject', '=', context.subject)
    .executeTakeFirst();
  if (!row) {
    return 'Confluence is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    ATLASSIAN_CONFLUENCE,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return 'Could not read the Confluence grant.';
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getAtlassianConfluenceApp(context.tenantId, context.origin ?? '');
    if (!app) return 'Confluence integration is no longer configured.';
    const refreshed = await refreshGrantTokens(
      new AtlassianAdapter(app.clientSecret, ATLASSIAN_CONFLUENCE),
      context.tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your Confluence authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the Confluence token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const site = readAtlassianMetadata(grant.metadata);
  if (!site.cloudId)
    return 'Confluence grant is missing its site id; reconnect on the Connectors page.';

  return { accessToken: grant.accessToken, cloudId: site.cloudId, accountId: grant.accountId };
}

function describeStatus(status: number): string {
  if (status === 403) {
    return (
      'Confluence refused (403) — the grant likely lacks the needed scope, or the Atlassian ' +
      'app registration is missing the permission. Reconnect Confluence after the admin fixes ' +
      'the app.'
    );
  }
  if (status === 429) return 'Confluence is rate limiting (429); try again shortly.';
  return `Confluence API answered ${status}`;
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

interface ConfluenceLogScope {
  tenantId: string;
  subject?: string;
}

async function confluenceRequest(
  scope: ConfluenceLogScope,
  access: ConfluenceAccess,
  pathAndQuery: string,
  init?: { method?: string; json?: unknown; body?: BodyInit; extraHeaders?: Record<string, string> }
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  const jsonBody = init?.json !== undefined ? JSON.stringify(init.json) : undefined;
  const body = jsonBody ?? init?.body;
  let response: Response;
  try {
    response = await fetch(
      `https://api.atlassian.com/ex/confluence/${access.cloudId}/wiki${pathAndQuery}`,
      {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${access.accessToken}`,
          Accept: 'application/json',
          ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init?.extraHeaders,
        },
        ...(body !== undefined ? { body } : {}),
      }
    );
  } catch {
    logger.warn('Confluence API unreachable', {
      component: 'confluence/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      path: pathAndQuery,
      method: init?.method ?? 'GET',
    });
    return { ok: false, error: 'Could not reach api.atlassian.com' };
  }
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    logger.warn('Confluence API non-OK response', {
      component: 'confluence/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      path: pathAndQuery,
      method: init?.method ?? 'GET',
      status: response.status,
      requestBody: jsonBody === undefined ? undefined : secure(truncateForLog(jsonBody)),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status) };
  }
  return { ok: true, response };
}

export async function confluenceGet(
  scope: ConfluenceLogScope,
  access: ConfluenceAccess,
  pathAndQuery: string
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const result = await confluenceRequest(scope, access, pathAndQuery);
  if (!result.ok) return result;
  const body: unknown = await result.response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed Confluence API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

/** POST/PUT with a JSON body; 204 answers have no body. */
async function confluenceWrite(
  method: 'POST' | 'PUT',
  scope: ConfluenceLogScope,
  access: ConfluenceAccess,
  pathAndQuery: string,
  json: unknown
): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; error: string }> {
  const result = await confluenceRequest(scope, access, pathAndQuery, { method, json });
  if (!result.ok) return result;
  const text = await result.response.text().catch(() => '');
  if (!text) return { ok: true, body: null };
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // no body worth parsing
  }
  return {
    ok: true,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null,
  };
}

export function confluencePost(
  scope: ConfluenceLogScope,
  access: ConfluenceAccess,
  pathAndQuery: string,
  json: unknown
): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; error: string }> {
  return confluenceWrite('POST', scope, access, pathAndQuery, json);
}

export function confluencePut(
  scope: ConfluenceLogScope,
  access: ConfluenceAccess,
  pathAndQuery: string,
  json: unknown
): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; error: string }> {
  return confluenceWrite('PUT', scope, access, pathAndQuery, json);
}

export async function confluenceDelete(
  scope: ConfluenceLogScope,
  access: ConfluenceAccess,
  pathAndQuery: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await confluenceRequest(scope, access, pathAndQuery, { method: 'DELETE' });
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * Upload a file to the v1-only multipart attachment endpoint — v2
 * attachments are read/delete only, so this is the sole write path.
 * Confluence requires the `X-Atlassian-Token: nocheck` header on this
 * endpoint or it refuses the request as a possible CSRF.
 */
export async function confluenceUpload(
  scope: ConfluenceLogScope,
  access: ConfluenceAccess,
  pathAndQuery: string,
  form: FormData
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const result = await confluenceRequest(scope, access, pathAndQuery, {
    method: 'POST',
    body: form,
    extraHeaders: { 'X-Atlassian-Token': 'nocheck' },
  });
  if (!result.ok) return result;
  const body: unknown = await result.response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed Confluence API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

export function values(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.results)
    ? body.results.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
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

/** Version numbers, counts, and the like are numbers, not strings — str() would silently return ''. */
export function num(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

export function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
