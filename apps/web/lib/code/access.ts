/**
 * Whether this person may make code projects: a Bitbucket connection of
 * their own that carries what the feature runs on. A code project is
 * cloned with their grant (`repository`), pushed with it
 * (`repository:write`) and opens its pull requests with it
 * (`pullrequest:write`); a connection missing any of these makes a
 * project that stalls at the first step needing it. So the Code page
 * says what to connect before it offers "New code project", the
 * new-project page sends the person back until then, and the create
 * route refuses.
 *
 * The scopes a connection carries are read with the tool registry's own
 * rule (mcp-tools/narrowed-scopes.ts), not a copy of it: Bitbucket's
 * token always carries the OAuth consumer's full scope set, so requested
 * ∩ granted when granted is recognized, requested alone otherwise —
 * and "otherwise" includes the granted list Bitbucket actually reports,
 * in a vocabulary (`read:repository:bitbucket-legacy`, …) that shares no
 * string with the classic names stored in requested_scopes. A plain
 * intersection against that list is empty, which once told a fully
 * connected person that their connection carried none of the three
 * checkboxes they had just approved.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
import { ATLASSIAN_BITBUCKET_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import { narrowedScopes } from '@/lib/mcp-tools/narrowed-scopes';

/** What a code project's clone, push and pull request stand on, in that order. */
export const CODE_PROJECT_SCOPES: readonly string[] = [
  'repository',
  'repository:write',
  'pullrequest:write',
];

export interface CodeProjectAccess {
  /** The person has connected Bitbucket at all. */
  connected: boolean;
  /** Of CODE_PROJECT_SCOPES, what the connection does not carry. */
  missingScopes: string[];
  /**
   * The Connectors page's checkbox labels that would supply the missing
   * scopes — what to tell the person to enable, in the page's own words.
   */
  missingOptions: string[];
  /** Connected, with nothing missing. */
  ok: boolean;
}

interface GrantScopes {
  requested_scopes: string[];
  granted_scopes: string[] | null;
}

/** The scopes a Bitbucket grant row carries, by the registry's rule. */
export function bitbucketScopesOf(row: GrantScopes): string[] {
  return narrowedScopes(row.requested_scopes, row.granted_scopes);
}

/** The catalog labels of the checkboxes that carry these scopes, in catalog order, once each. */
export function scopeOptionLabels(scopes: readonly string[]): string[] {
  const wanted = new Set(scopes);
  return ATLASSIAN_BITBUCKET_SCOPE_OPTIONS.filter((option) =>
    option.scopes.some((scope) => wanted.has(scope))
  ).map((option) => option.label);
}

/** The access a grant row (or none) gives — pure, for the page and the route alike. */
export function codeProjectAccessOf(row: GrantScopes | undefined): CodeProjectAccess {
  if (!row) {
    return {
      connected: false,
      missingScopes: [...CODE_PROJECT_SCOPES],
      missingOptions: scopeOptionLabels(CODE_PROJECT_SCOPES),
      ok: false,
    };
  }
  const carried = new Set(bitbucketScopesOf(row));
  const missingScopes = CODE_PROJECT_SCOPES.filter((scope) => !carried.has(scope));
  return {
    connected: true,
    missingScopes,
    missingOptions: scopeOptionLabels(missingScopes),
    ok: missingScopes.length === 0,
  };
}

export async function codeProjectAccess(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<CodeProjectAccess> {
  const row = await db
    .selectFrom('provider_grants')
    .select(['requested_scopes', 'granted_scopes'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ATLASSIAN_BITBUCKET)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
  return codeProjectAccessOf(row);
}

/**
 * One sentence saying what to do, for the page and the route's refusal:
 * connect Bitbucket, or reconnect it with the missing checkboxes on.
 */
export function codeProjectAccessMessage(access: CodeProjectAccess): string | null {
  if (access.ok) return null;
  const list = joinNames(access.missingOptions);
  return access.connected
    ? `Your Bitbucket connection does not carry ${list}. Reconnect Bitbucket on the Connectors page with ${access.missingOptions.length === 1 ? 'that' : 'those'} enabled to make code projects.`
    : `Connect Bitbucket on the Connectors page, with ${list} enabled, to make code projects.`;
}

function joinNames(names: string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
