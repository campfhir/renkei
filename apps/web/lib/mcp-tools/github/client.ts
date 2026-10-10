/**
 * GitHub REST client, over the caller's own delegated grant on Renkei's
 * GitHub App. Follows the Bitbucket/Confluence pattern — each call
 * resolves its own access fresh from the grant; the token itself lives in
 * the delegate worker (docs/delegate-key-design.md), whose fetcher
 * attaches it, refreshes it when due and retries a 401 — with two shape
 * differences GitHub itself imposes:
 *
 *  - List endpoints answer a bare JSON array (or, for search, {items,
 *    total_count}), never Bitbucket's {values, next} envelope, and
 *    pagination is a `Link` response header (rel="next"), not a body
 *    field — so `hasMore` here reads that header instead of a `moreLine`
 *    over the parsed body.
 *  - A file's raw content needs the `application/vnd.github.raw+json`
 *    Accept header (otherwise GitHub answers base64-in-JSON), and a
 *    diff needs `application/vnd.github.v3.diff` — both routed through
 *    ghRawText's `accept` parameter.
 */

import { GITHUB, readGitHubMetadata } from '@renkei/provider-grants';
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
 * GitHub's REST API. A deployment may point it elsewhere
 * (GITHUB_API_BASE_URL) — the browser suite runs the app against a
 * stand-in that answers the few endpoints the Code pages read. The
 * delegate only forwards to GitHub's own hosts, so a stand-in needs a
 * delegate that allows it too.
 */
export const GITHUB_API_BASE =
  process.env.GITHUB_API_BASE_URL?.replace(/\/+$/, '') || 'https://api.github.com';

export interface GitHubAccess {
  /** The fetcher every call goes out through — the delegate's, for the caller's grant. */
  auth: AuthedFetch;
  /** The connected account's numeric id — GitHub's durable identity key. */
  accountId: string;
  /** The connected account's login, for display and for API paths. */
  login: string;
}

/** The caller's GitHub grant as a fetcher, plus who it is. */
export async function resolveGitHubAccess(
  context: Pick<MCPToolContext, 'subject' | 'origin'>
): Promise<GitHubAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';

  // By subject: the delegate picks the person's grant on this provider, the
  // way the row lookup here used to (newest wins on a reconnect).
  const ref = { provider: GITHUB, subject: context.subject };
  const described = await delegateGrants().describe(ref);
  if (!described.ok) {
    return described.err.type === 'GRANT_UNREADABLE' || described.err.type === 'DELEGATE_ERROR'
      ? 'Could not read the GitHub grant.'
      : grantRefusalText(described.err.type, 'GitHub');
  }

  return {
    auth: grantFetch(ref),
    accountId: described.val.accountId,
    login: readGitHubMetadata(described.val.metadata).login,
  };
}

interface GitHubLogScope {
  subject?: string;
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * One GitHub API call. The Response comes back as-is, ok or not — the
 * shared `describeGitHubFailure` renders a non-2xx answer for the model;
 * only an unreachable host becomes a local error string here.
 */
export async function githubRequest(
  scope: GitHubLogScope,
  access: GitHubAccess,
  pathAndQuery: string,
  init?: {
    method?: string;
    json?: unknown;
    accept?: string;
  }
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  const jsonBody = init?.json !== undefined ? JSON.stringify(init.json) : undefined;
  let response: Response;
  try {
    // No Authorization here: the fetcher's owner (the delegate) attaches it.
    response = await access.auth(`${GITHUB_API_BASE}${pathAndQuery}`, {
      method: init?.method ?? 'GET',
      headers: {
        Accept: init?.accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(jsonBody !== undefined ? { body: jsonBody } : {}),
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('GitHub API unreachable', {
      component: 'github/fetch',
      subject: scope.subject,
      path: pathAndQuery,
      method: init?.method ?? 'GET',
      timedOut,
    });
    return {
      ok: false,
      error: timedOut
        ? `api.github.com timed out after ${REQUEST_TIMEOUT_MS}ms`
        : 'Could not reach api.github.com',
    };
  }
  const refusal = delegateRefusal(response);
  if (refusal) {
    // The delegate's own refusal never reached GitHub — the resolver's
    // words, not a GitHub status.
    logger.warn('Delegate refused the GitHub call', {
      component: 'github/fetch',
      subject: scope.subject,
      path: pathAndQuery,
      refusal,
    });
    return { ok: false, error: grantRefusalText(refusal, 'GitHub') };
  }
  if (!response.ok) {
    const responseBody = await response
      .clone()
      .text()
      .catch(() => '');
    logger.warn('GitHub API non-OK response', {
      component: 'github/fetch',
      subject: scope.subject,
      path: pathAndQuery,
      method: init?.method ?? 'GET',
      status: response.status,
      // Which grant the call rode on, never its bytes.
      grantKey: access.auth.grantKey,
      requestBody: jsonBody === undefined ? undefined : secure(truncateForLog(jsonBody)),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
  }
  return { ok: true, response };
}

/**
 * GitHub's own error prose, when it sent any — {"message": "…",
 * "documentation_url": "…"} on most endpoints — else a status-line
 * explanation.
 */
export async function describeGitHubFailure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const record = rec(body);
  const message = str(record.message);
  if (response.status === 401) {
    return (
      `GitHub API 401: ${message || 'Bad credentials'} — reconnect GitHub on the ` +
      `Connectors page.`
    );
  }
  if (response.status === 403 && /rate limit/i.test(message)) {
    return `GitHub is rate limiting (403): ${message}. Try again shortly.`;
  }
  if (response.status === 403) {
    return (
      `GitHub API 403: ${message || 'Forbidden'} — the GitHub App likely lacks the needed ` +
      `permission, or your account lacks access to this repository/organization. An admin ` +
      `can widen the App's permissions on github.com/settings/apps (or the org's copy of it); ` +
      `reconnect afterwards.`
    );
  }
  if (response.status === 404) {
    return (
      `GitHub API 404: ${message || 'Not Found'} — either the owner/repository/id in the ` +
      `request does not exist, or Renkei's GitHub App is not installed on it (or was not ` +
      `granted access to that repository at install time).`
    );
  }
  if (message) return `GitHub API ${response.status}: ${message}`;
  if (response.status === 422)
    return 'GitHub could not process this request (422) — check the arguments.';
  return `GitHub API answered ${response.status}`;
}

// Type-only, to keep the runtime import graph acyclic: github-auth.ts
// imports this module's functions; this module only names its interface.
import type { GitHubAuth } from './github-auth';

/** Whether a Link header carries a rel="next" page. */
function hasNextPage(response: Response): boolean {
  return /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '');
}

/**
 * One JSON call through the injected auth — the shape nearly every tool
 * wants. Non-2xx (local denial or GitHub's own answer) becomes the
 * rendered error string; `hasMore` reads the Link header so callers don't
 * each re-parse it.
 */
export async function ghJson(
  auth: GitHubAuth,
  requiredScopes: readonly string[],
  pathAndQuery: string,
  init?: { method?: string; json?: unknown }
): Promise<{ ok: true; body: unknown; hasMore: boolean } | { ok: false; error: string }> {
  const response = await auth.fetch(requiredScopes, pathAndQuery, init);
  if (!response.ok) return { ok: false, error: await describeGitHubFailure(response) };
  const hasMore = hasNextPage(response);
  const text = await response.text().catch(() => '');
  if (!text) return { ok: true, body: null, hasMore };
  try {
    return { ok: true, body: JSON.parse(text), hasMore };
  } catch {
    return { ok: false, error: 'Malformed GitHub API response' };
  }
}

/** One raw-text call — diffs, patches, file contents. */
export async function ghRawText(
  auth: GitHubAuth,
  requiredScopes: readonly string[],
  pathAndQuery: string,
  accept: string
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const response = await auth.fetch(requiredScopes, pathAndQuery, { accept });
  if (!response.ok) return { ok: false, error: await describeGitHubFailure(response) };
  return { ok: true, text: await response.text().catch(() => '') };
}

/** A list response as an array of records, defensively. */
export function arr(body: unknown): Record<string, unknown>[] {
  return Array.isArray(body)
    ? body.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}

/** One more page exists — said out loud so a truncated list is never silent. */
export function moreLine(hasMore: boolean, hint: string): string {
  return hasMore ? `\n\nMore exist — ${hint}` : '';
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

/** The browser URL for a repository. */
export function repoUrl(owner: string, repo: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function prUrl(owner: string, repo: string, number: string | number): string {
  return `${repoUrl(owner, repo)}/pull/${number}`;
}

export function runUrl(owner: string, repo: string, runId: string | number): string {
  return `${repoUrl(owner, repo)}/actions/runs/${runId}`;
}
