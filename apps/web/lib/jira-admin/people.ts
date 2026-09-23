/**
 * People and groups, resolved through the Jira Administration grant — for
 * a new space's lead and the members a proposal adds to its roles.
 *
 * The rules are jira/resolve-user.ts's, because the stakes are the same or
 * higher (a role grants access to a whole space): an exact email wins, one
 * match is a match, and several is refused with the names rather than
 * guessed at. Unlike that resolver this one also returns the display name,
 * since the review page must say WHO gets access, not an account id.
 */

import { looksLikeAccountId } from '@/lib/mcp-tools/jira/resolve-user';
import {
  jiraAdminGet,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';

interface LogScope {
  tenantId: string;
  subject?: string;
}

export interface Person {
  accountId: string;
  displayName: string;
}

export interface Group {
  groupId: string;
  name: string;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };

function personOf(user: Record<string, unknown>): Person {
  const accountId = str(user.accountId);
  return { accountId, displayName: str(user.displayName) || accountId };
}

export async function resolvePerson(
  scope: LogScope,
  access: JiraAdminAccess,
  raw: string
): Promise<Resolved<Person>> {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'No person was given.' };

  if (looksLikeAccountId(value)) {
    const result = await jiraAdminGet(
      scope,
      access,
      `/rest/api/3/user?accountId=${encodeURIComponent(value)}`
    );
    if (!result.ok) return { ok: false, reason: `No Jira user has the account id ${value}.` };
    return { ok: true, value: personOf(rec(result.body)) };
  }

  const result = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/user/search?query=${encodeURIComponent(value)}&maxResults=50`
  );
  if (!result.ok) return { ok: false, reason: `Looking up "${value}": ${result.error}` };
  const candidates = records(result.body).filter(
    (user) => str(user.accountId) && user.active !== false && user.accountType !== 'app'
  );
  // An exact email wins outright — when the site shows emails at all.
  const exact = candidates.filter(
    (user) => str(user.emailAddress).trim().toLowerCase() === value.toLowerCase()
  );
  const pick = exact.length > 0 ? exact : candidates;
  if (pick.length === 1 && pick[0]) return { ok: true, value: personOf(pick[0]) };
  if (pick.length === 0) return { ok: false, reason: `No Jira user matches "${value}".` };
  return {
    ok: false,
    reason:
      `"${value}" matches ${pick.length} people — use the email or account id of the one you ` +
      `mean: ${pick
        .slice(0, 5)
        .map((user) => `${str(user.displayName)} (${str(user.accountId)})`)
        .join(', ')}${pick.length > 5 ? ', …' : ''}`,
  };
}

/** A group by its exact name, with the id Jira prefers role actors named by. */
export async function resolveGroup(
  scope: LogScope,
  access: JiraAdminAccess,
  raw: string
): Promise<Resolved<Group>> {
  const name = raw.trim();
  if (!name) return { ok: false, reason: 'No group was given.' };
  const result = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/group/bulk?groupName=${encodeURIComponent(name)}&maxResults=10`
  );
  if (!result.ok) return { ok: false, reason: `Looking up group "${name}": ${result.error}` };
  const match = records(result.body).find(
    (group) => str(group.name).toLowerCase() === name.toLowerCase()
  );
  return match
    ? { ok: true, value: { groupId: str(match.groupId), name: str(match.name) } }
    : { ok: false, reason: `No Jira group is named "${name}".` };
}
