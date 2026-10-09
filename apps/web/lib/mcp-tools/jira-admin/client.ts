/**
 * Jira administration REST client, over the caller's own delegated grant on
 * the fifth Atlassian app ("Renkei Jira Admin", classic scopes — see
 * lib/atlassian-scopes.ts for why it is its own app).
 *
 * Confluence's pattern (../confluence/client.ts), not Jira's: every tool
 * call resolves its access fresh from the grant, so a disconnect or a
 * lapsed grant surfaces as a plain sentence — and the admin grant never
 * rides the Jira app's context fields. The token itself lives in the
 * delegate worker (docs/delegate-key-design.md): the `auth` fetcher here
 * attaches it, refreshes it when due and retries a 401.
 *
 * Everything lives on the Jira platform gateway,
 * api.atlassian.com/ex/jira/{cloudId}: configuration under /rest/api/3, the
 * Plans API under /rest/api/3/plans, and (a later stage) the Forms API under
 * /forms.
 */

import { ATLASSIAN_ADMIN, readAtlassianMetadata } from '@renkei/provider-grants';
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
 * The Jira platform gateway, less the cloud id. A deployment may point it
 * elsewhere (JIRA_ADMIN_API_BASE_URL) — the browser suite runs the app
 * against a stand-in for the few option endpoints a change request applies,
 * the way BITBUCKET_API_BASE_URL serves the Code pages. The delegate only
 * forwards to Atlassian's own hosts, so a stand-in needs a delegate that
 * allows it too.
 */
const JIRA_ADMIN_API_BASE =
  process.env.JIRA_ADMIN_API_BASE_URL?.replace(/\/+$/, '') || 'https://api.atlassian.com/ex/jira';

export interface JiraAdminAccess {
  cloudId: string;
  /** The site's browser URL (https://x.atlassian.net), for links; may be empty. */
  siteUrl: string;
  accountId: string;
  /** The fetcher every call goes out through — the delegate's, for the caller's grant. */
  auth: AuthedFetch;
}

/**
 * The caller's Jira Admin grant as a fetcher, plus its site. Takes only who
 * is asking, so the apply route — a browser session, not an MCP call —
 * resolves the same grant the same way.
 */
export async function resolveJiraAdminAccess(
  context: Pick<MCPToolContext, 'tenantId' | 'subject' | 'origin'>
): Promise<JiraAdminAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';

  const ref = { tenantId: context.tenantId, provider: ATLASSIAN_ADMIN, subject: context.subject };
  const described = await delegateGrants().describe(ref);
  if (!described.ok) {
    if (described.err.type === 'NO_GRANT') {
      return (
        'Jira Administration is not connected. Connect it on the Connectors page (it is ' +
        'separate from Jira), then try again.'
      );
    }
    return described.err.type === 'GRANT_UNREADABLE' || described.err.type === 'DELEGATE_ERROR'
      ? 'Could not read the Jira Administration grant.'
      : grantRefusalText(described.err.type, 'Jira Administration');
  }

  const site = readAtlassianMetadata(described.val.metadata);
  if (!site.cloudId) {
    return 'The Jira Administration grant is missing its site id; reconnect on the Connectors page.';
  }

  return {
    cloudId: site.cloudId,
    siteUrl: site.siteUrl,
    accountId: described.val.accountId,
    auth: grantFetch(ref),
  };
}

/**
 * Jira's own reason, when its error body carries one — "The custom field
 * was not found." says more than any status code. At most two, so a
 * validation wall stays readable.
 */
function jiraReasons(body: unknown): string[] {
  const record = rec(body);
  const messages = Array.isArray(record.errorMessages)
    ? record.errorMessages.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];
  const fieldErrors = Object.values(rec(record.errors)).filter(
    (m): m is string => typeof m === 'string' && m.length > 0
  );
  return [...messages, ...fieldErrors].slice(0, 2);
}

function describeStatus(status: number, reasons: string[]): string {
  const why = reasons.length > 0 ? ` ${reasons.join(' ')}` : '';
  if (status === 401) {
    return (
      'Jira refused the Jira Administration token (401). The app registration may be missing ' +
      `a classic scope this call needs; reconnect after an admin fixes it.${why}`
    );
  }
  if (status === 403) {
    return (
      'Jira refused (403): this needs Administer Jira, or Administer Projects for the space. ' +
      `jira_admin_check_access shows what the connected account holds.${why}`
    );
  }
  if (status === 404) return `Not found (404), or not visible to the connected account.${why}`;
  if (status === 429) return 'Jira is rate limiting (429); try again shortly.';
  return `Jira answered ${status}.${why}`;
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

interface JiraAdminLogScope {
  tenantId: string;
  subject?: string;
}

export type JiraAdminResult =
  | { ok: true; body: unknown }
  /** `status` is Jira's answer when there was one; absent when Jira was unreachable. */
  | { ok: false; error: string; status?: number };

/** GET a path under the site's Jira gateway; any JSON shape comes back as `unknown`. */
export async function jiraAdminGet(
  scope: JiraAdminLogScope,
  access: JiraAdminAccess,
  pathAndQuery: string
): Promise<JiraAdminResult> {
  return jiraAdminRequest(scope, access, 'GET', pathAndQuery);
}

/**
 * Every record of a startAt-paged listing, page after page until Jira says
 * the last one came back — `truncated` when there were more than `maxPages`
 * pages, so a caller can say "and more" rather than pretend it saw all.
 */
export async function jiraAdminPages(
  scope: JiraAdminLogScope,
  access: JiraAdminAccess,
  pathAndQuery: string,
  maxPages = 10
): Promise<
  | { ok: true; values: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; error: string; status?: number }
> {
  const values: Record<string, unknown>[] = [];
  const joiner = pathAndQuery.includes('?') ? '&' : '?';
  for (let page = 0; page < maxPages; page++) {
    const result = await jiraAdminGet(
      scope,
      access,
      `${pathAndQuery}${joiner}startAt=${page * PAGE_SIZE}&maxResults=${PAGE_SIZE}`
    );
    if (!result.ok) return result;
    const batch = records(result.body);
    values.push(...batch);
    if (rec(result.body).isLast !== false || batch.length === 0) {
      return { ok: true, values, truncated: false };
    }
  }
  return { ok: true, values, truncated: true };
}

const PAGE_SIZE = 100;

/**
 * POST or PUT a JSON body. Only the change-request executor
 * (lib/jira-admin) calls this — no MCP tool writes to Jira directly; a tool
 * proposes, and a person applies from a signed-in session.
 */
export async function jiraAdminSend(
  scope: JiraAdminLogScope,
  access: JiraAdminAccess,
  method: 'POST' | 'PUT',
  pathAndQuery: string,
  body: unknown
): Promise<JiraAdminResult> {
  return jiraAdminRequest(scope, access, method, pathAndQuery, body);
}

async function jiraAdminRequest(
  scope: JiraAdminLogScope,
  access: JiraAdminAccess,
  method: 'GET' | 'POST' | 'PUT',
  pathAndQuery: string,
  body?: unknown
): Promise<JiraAdminResult> {
  let response: Response;
  try {
    // No Authorization here: the fetcher's owner (the delegate) attaches it.
    response = await access.auth(`${JIRA_ADMIN_API_BASE}/${access.cloudId}${pathAndQuery}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Jira admin API unreachable', {
      component: 'jira-admin/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      method,
      path: pathAndQuery,
      timedOut,
    });
    const reason = timedOut
      ? `api.atlassian.com timed out after ${REQUEST_TIMEOUT_MS}ms`
      : 'Could not reach api.atlassian.com';
    return {
      ok: false,
      // A write that timed out may still have landed; say so rather than
      // implying nothing happened.
      error:
        method === 'GET' || !timedOut
          ? reason
          : `${reason} — the change may still have gone through; check Jira before retrying.`,
    };
  }
  const refusal = delegateRefusal(response);
  if (refusal) {
    // The delegate's own refusal never reached Jira — the resolver's words,
    // not a Jira status.
    logger.warn('Delegate refused the Jira admin call', {
      component: 'jira-admin/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      method,
      path: pathAndQuery,
      refusal,
    });
    return { ok: false, error: grantRefusalText(refusal, 'Jira Administration') };
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — the status decides what the caller hears.
  }
  if (!response.ok) {
    logger.warn('Jira admin API non-OK response', {
      component: 'jira-admin/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      method,
      path: pathAndQuery,
      status: response.status,
      responseBody: text ? secure(truncateForLog(text)) : undefined,
    });
    return {
      ok: false,
      error: describeStatus(response.status, jiraReasons(parsed)),
      status: response.status,
    };
  }
  return { ok: true, body: parsed };
}

export function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

export function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The records in an array — a bare array body, or a paged body's `values`. */
export function records(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : rec(value).values;
  return Array.isArray(list)
    ? list.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}
