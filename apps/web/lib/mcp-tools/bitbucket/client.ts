/**
 * Bitbucket Cloud REST client, over the caller's own delegated grant on
 * the fourth Atlassian app ("Renkei Bitbucket"). Follows the Confluence
 * pattern — each call resolves its own access fresh from the grant; the
 * token itself lives in the delegate worker (docs/delegate-key-design.md),
 * whose fetcher attaches it, refreshes it when due and retries a 401 —
 * with one welcome simplification: there is no cloud-id gateway.
 * Everything lives under https://api.bitbucket.org/2.0 and descriptions,
 * PR bodies and comments are plain markdown, so nothing here converts
 * formats.
 */

import { ATLASSIAN_BITBUCKET, readBitbucketMetadata } from '@renkei/provider-grants';
import {
  delegateGrants,
  delegateRefusal,
  grantFetch,
  type AuthedFetch,
} from '@renkei/delegate-client';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import { grantRefusalText } from '@/lib/grant-refusals';
import { REQUEST_TIMEOUT_MS, isTimeoutError, timeoutSignal } from '../fetch-guard';

/**
 * Bitbucket Cloud's API. A deployment may point it elsewhere
 * (BITBUCKET_API_BASE_URL) — the browser suite runs the app against a
 * stand-in that answers the few endpoints the Code pages read. The
 * delegate only forwards to Bitbucket's own hosts, so a stand-in needs a
 * delegate that allows it too.
 */
export const BITBUCKET_API_BASE =
  process.env.BITBUCKET_API_BASE_URL?.replace(/\/+$/, '') || 'https://api.bitbucket.org/2.0';

export interface BitbucketAccess {
  /**
   * The fetcher every call goes out through. Production's is the delegate's
   * for the caller's grant (Bearer attached there); a workspace API token
   * (test support) would authenticate with Basic auth instead — carrying a
   * fetcher here is what makes that swappable.
   */
  auth: AuthedFetch;
  /** The connected account's uuid — Bitbucket's durable identity key. */
  accountId: string;
  /** The connected account's username, for display and for API paths. */
  username: string;
}

/** The caller's Bitbucket grant as a fetcher, plus who it is. */
export async function resolveBitbucketAccess(
  context: Pick<MCPToolContext, 'tenantId' | 'subject' | 'origin'>
): Promise<BitbucketAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';

  // By subject: the delegate picks the person's grant on this provider, the
  // way the row lookup here used to (newest wins on a reconnect).
  const ref = {
    provider: ATLASSIAN_BITBUCKET,
    subject: context.subject,
  };
  const described = await delegateGrants().describe(ref);
  if (!described.ok) {
    return described.err.type === 'GRANT_UNREADABLE' || described.err.type === 'DELEGATE_ERROR'
      ? 'Could not read the Bitbucket grant.'
      : grantRefusalText(described.err.type, 'Bitbucket');
  }

  return {
    auth: grantFetch(ref),
    accountId: described.val.accountId,
    username: readBitbucketMetadata(described.val.metadata).username,
  };
}

interface BitbucketLogScope {
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
    // No Authorization here: the fetcher's owner (the delegate) attaches it.
    response = await access.auth(`${BITBUCKET_API_BASE}${pathAndQuery}`, {
      method: init?.method ?? 'GET',
      headers: {
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
  const refusal = delegateRefusal(response);
  if (refusal) {
    // The delegate's own refusal never reached Bitbucket — the resolver's
    // words, not Bitbucket's anonymous 404.
    logger.warn('Delegate refused the Bitbucket call', {
      component: 'bitbucket/fetch',
      subject: scope.subject,
      path: pathAndQuery,
      refusal,
    });
    return { ok: false, error: grantRefusalText(refusal, 'Bitbucket') };
  }
  if (!response.ok) {
    const responseBody = await response
      .clone()
      .text()
      .catch(() => '');
    logger.warn('Bitbucket API non-OK response', {
      component: 'bitbucket/fetch',
      subject: scope.subject,
      path: pathAndQuery,
      method: init?.method ?? 'GET',
      status: response.status,
      // Which grant the call rode on, never its bytes: Bitbucket answers
      // credential-less requests with an anonymous 404 that reads like a
      // wrong URL, and this is the field that tells them apart.
      grantKey: access.auth.grantKey,
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
  // Bitbucket hides auth-gated endpoints from requests it treats as
  // anonymous — a missing or empty Authorization header gets this exact
  // "Resource not found / no API hosted at this URL" 404 on endpoints that
  // very much exist (a bad token gets 401, a missing scope 403). Verified
  // against the live API; without this line the error reads as a wrong URL
  // and sends whoever debugs it in exactly the wrong direction.
  if (response.status === 404 && message === 'Resource not found') {
    return (
      `Bitbucket API 404: ${message} — either the workspace/repository/id in the request ` +
      `does not exist, or the request reached Bitbucket without usable credentials ` +
      `(Bitbucket answers anonymous requests to real endpoints with this same 404). ` +
      `If ids look right, reconnect Bitbucket on the Connectors page.`
    );
  }
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
  let body: unknown;
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
