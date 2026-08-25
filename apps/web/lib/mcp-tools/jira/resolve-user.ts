/**
 * Turning "who" into an accountId.
 *
 * Jira Cloud dropped name/email identification in field objects for GDPR:
 * `{ name: 'amanda@nems.org' }` and `{ accountId: 'amanda@nems.org' }` are
 * both accepted by the API and both write NOTHING. No error — the field
 * simply stays empty while the response says the issue was updated. That
 * silent no-op is why every user-typed field has to be resolved before the
 * write rather than optimistically passed through.
 *
 * The assignee path has done this for a while. Every OTHER user field —
 * Reporter, and every custom user picker an org has added — did not: they
 * refused the value and told the caller to go and call `jira_search_users`
 * themselves. That is work the tool is holding all the information to do,
 * and handing it back produced exactly the "could not be resolved" note
 * this module exists to stop.
 *
 * Resolution stays strict. One match is a match; several is ambiguous and
 * reported with the names, because picking the first would eventually
 * assign someone else's ticket to the wrong person and nothing downstream
 * would notice.
 */

import { granularJiraScopes, type JiraAuth } from './jira-auth';

export type UserResolution = { ok: true; id: string } | { ok: false; reason: string };

/**
 * Does this already look like an Atlassian accountId?
 *
 * Deliberately loose: ids come in several shapes (`5b21a397…`,
 * `557058:2f1a…`, `qm:…`), and the cost of guessing wrong is only a search
 * that finds nothing. Anything containing `@` is a person's email, never an
 * id.
 */
export function looksLikeAccountId(value: string): boolean {
  return !value.includes('@') && /^[0-9a-zA-Z:_-]{16,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** How a candidate should be described when there is more than one. */
function describe(user: Record<string, unknown>): string {
  const name = isString(user.displayName) ? user.displayName : '(no name)';
  const id = isString(user.accountId) ? user.accountId : '(no id)';
  return `${name} (${id})`;
}

/**
 * A resolver with a cache for the life of one tool call.
 *
 * A create that names the same person as reporter, assignee and approver
 * should cost one search, not three — and the searches are the slow part of
 * a write that is otherwise a single request.
 */
export function createUserResolver(auth: JiraAuth): (value: string) => Promise<UserResolution> {
  const cache = new Map<string, Promise<UserResolution>>();

  return (value: string) => {
    const key = value.trim().toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = resolveUserId(auth, value);
    cache.set(key, pending);
    return pending;
  };
}

export async function resolveUserId(auth: JiraAuth, raw: string): Promise<UserResolution> {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'no user was given' };
  if (looksLikeAccountId(value)) return { ok: true, id: value };

  const response = await auth.fetch(
    granularJiraScopes('jira_search_users', true),
    `/rest/api/3/user/search?query=${encodeURIComponent(value)}&maxResults=50`
  );
  if (!response.ok) {
    return { ok: false, reason: `user search failed for "${value}" (HTTP ${response.status})` };
  }

  const body: unknown = await response.json().catch(() => null);
  const candidates = Array.isArray(body)
    ? body.filter(isRecord).filter((user) => isString(user.accountId))
    : [];

  // An exact email match wins outright — "amanda.wong@" must not be
  // ambiguous just because "amanda.wong.contractor@" also exists.
  //
  // Only when the directory actually returns emails, though: a site with
  // profile visibility restricted hides emailAddress entirely, and treating
  // "no exact match" as failure there would break resolution for precisely
  // the orgs most careful about privacy. When none is exposed, fall back to
  // whatever the search matched on.
  const exact = candidates.filter(
    (user) =>
      isString(user.emailAddress) && user.emailAddress.trim().toLowerCase() === value.toLowerCase()
  );
  const pick = exact.length > 0 ? exact : candidates;

  if (pick.length === 1) return { ok: true, id: String(pick[0].accountId) };
  if (pick.length === 0) return { ok: false, reason: `no Jira user matches "${value}"` };
  return {
    ok: false,
    reason:
      `"${value}" matches ${pick.length} users — pass the accountId of the one you mean: ` +
      pick.slice(0, 5).map(describe).join(', ') +
      (pick.length > 5 ? ', …' : ''),
  };
}
