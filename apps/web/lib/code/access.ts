/**
 * Whether this person may make a code project on a given git host: a
 * connection of their own that carries what the feature runs on. A code
 * project is cloned with their grant (`repository`), pushed with it
 * (`repository:write`) and opens its pull requests with it
 * (`pullrequest:write`); a connection missing any of these makes a
 * project that stalls at the first step needing it. So the Code page
 * says what to connect before it offers "New code project", the
 * new-project page sends the person back until then, and the create
 * route refuses.
 *
 * The scopes a connection carries are read with the tool registry's own
 * rule (mcp-tools/narrowed-scopes.ts), not a copy of it: both
 * Bitbucket's OAuth consumer and Renkei's GitHub App fix their real
 * permissions on the app/consumer registration rather than on the
 * authorize call, so requested ∩ granted when granted is recognized,
 * requested alone otherwise — and "otherwise" includes a granted list in
 * a vocabulary that shares no string with the classic names stored in
 * requested_scopes (observed for Bitbucket: `read:repository:bitbucket-legacy`,
 * …). A plain intersection against that list is empty, which once told a
 * fully connected person that their connection carried none of the three
 * checkboxes they had just approved.
 *
 * Both hosts happen to use the SAME three capability ids
 * (`repository`, `repository:write`, `pullrequest:write` — see
 * github-scopes.ts's header), which is what lets this module stay one
 * set of pure functions parametrized by provider rather than a second
 * copy of them.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { ATLASSIAN_BITBUCKET_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import { GITHUB_SCOPE_OPTIONS } from '@/lib/github-scopes';
import type { ScopeOption } from '@/lib/scope-catalog';
import { narrowedScopes } from '@/lib/mcp-tools/narrowed-scopes';

/** What a code project's clone, push and pull request stand on, in that order. */
export const CODE_PROJECT_SCOPES: readonly string[] = [
  'repository',
  'repository:write',
  'pullrequest:write',
];

export interface CodeProjectAccess {
  /** The person has connected this provider at all. */
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

/** The connector's display name and scope catalog, by provider. */
function catalogFor(provider: string): { label: string; options: ScopeOption[] } {
  return provider === GITHUB
    ? { label: 'GitHub', options: GITHUB_SCOPE_OPTIONS }
    : { label: 'Bitbucket', options: ATLASSIAN_BITBUCKET_SCOPE_OPTIONS };
}

/** The scopes a grant row carries, by the registry's rule. */
export function grantScopesOf(row: GrantScopes): string[] {
  return narrowedScopes(row.requested_scopes, row.granted_scopes);
}

/** The catalog labels of the checkboxes that carry these scopes, in catalog order, once each. */
export function scopeOptionLabels(
  scopes: readonly string[],
  provider: string = ATLASSIAN_BITBUCKET
): string[] {
  const wanted = new Set(scopes);
  return catalogFor(provider)
    .options.filter((option) => option.scopes.some((scope) => wanted.has(scope)))
    .map((option) => option.label);
}

/** The access a grant row (or none) gives — pure, for the page and the route alike. */
export function codeProjectAccessOf(
  row: GrantScopes | undefined,
  provider: string = ATLASSIAN_BITBUCKET
): CodeProjectAccess {
  if (!row) {
    return {
      connected: false,
      missingScopes: [...CODE_PROJECT_SCOPES],
      missingOptions: scopeOptionLabels(CODE_PROJECT_SCOPES, provider),
      ok: false,
    };
  }
  const carried = new Set(grantScopesOf(row));
  const missingScopes = CODE_PROJECT_SCOPES.filter((scope) => !carried.has(scope));
  return {
    connected: true,
    missingScopes,
    missingOptions: scopeOptionLabels(missingScopes, provider),
    ok: missingScopes.length === 0,
  };
}

/**
 * The scopes one person's connection to a host carries, by the same rule
 * — or null when they have not connected it. For a page that stands on
 * scopes beyond CODE_PROJECT_SCOPES (a project's Pipelines setup) and
 * wants to say, in the Connectors page's words, what is missing.
 */
export async function grantScopes(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  provider: string = ATLASSIAN_BITBUCKET
): Promise<string[] | null> {
  const row = await db
    .selectFrom('provider_grants')
    .select(['requested_scopes', 'granted_scopes'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', subject)
    .orderBy('updated_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? grantScopesOf(row) : null;
}

export async function codeProjectAccess(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  provider: string = ATLASSIAN_BITBUCKET
): Promise<CodeProjectAccess> {
  const row = await db
    .selectFrom('provider_grants')
    .select(['requested_scopes', 'granted_scopes'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
  return codeProjectAccessOf(row, provider);
}

/** Access on every git host a code project can use, keyed by provider — for the Code page. */
export async function codeProjectProviderAccess(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Record<string, CodeProjectAccess>> {
  const [bitbucket, github] = await Promise.all([
    codeProjectAccess(db, tenantId, subject, ATLASSIAN_BITBUCKET),
    codeProjectAccess(db, tenantId, subject, GITHUB),
  ]);
  return { [ATLASSIAN_BITBUCKET]: bitbucket, [GITHUB]: github };
}

/**
 * One sentence saying what to do, for the page and the route's refusal:
 * connect the host, or reconnect it with the missing checkboxes on.
 */
export function codeProjectAccessMessage(
  access: CodeProjectAccess,
  provider: string = ATLASSIAN_BITBUCKET
): string | null {
  if (access.ok) return null;
  const label = catalogFor(provider).label;
  const list = joinNames(access.missingOptions);
  return access.connected
    ? `Your ${label} connection does not carry ${list}. Reconnect ${label} on the Connectors page with ${access.missingOptions.length === 1 ? 'that' : 'those'} enabled to make code projects.`
    : `Connect ${label} on the Connectors page, with ${list} enabled, to make code projects.`;
}

function joinNames(names: string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
