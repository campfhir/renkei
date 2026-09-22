/**
 * Renkei's own capability bundles for the GitHub App connector, grouped
 * into checkboxes via ScopePicker — the Bitbucket shape, not Atlassian's:
 * a GitHub App's real PERMISSIONS are fixed on the App's registration
 * (contents, pull_requests, actions, metadata, …) and are never requested
 * as an authorize-URL parameter, so these "scopes" name nothing GitHub
 * itself reads. They are Renkei's own bookkeeping — what requested_scopes
 * records and what the tool gate (github/scopes.ts) and
 * resolveWorkspaceGitCredential narrow by, exactly the role Bitbucket's
 * fixed-consumer scopes play (see atlassian-scopes.ts's header and
 * narrowedScopes).
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const GITHUB_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'code', label: 'Repositories & code' },
  { id: 'prs', label: 'Pull requests' },
  { id: 'actions', label: 'Actions' },
  { id: 'admin', label: 'Access management' },
];

export const GITHUB_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'gh-code-read',
    label: 'Read repositories & code',
    hint: 'Accounts/installations, repositories, branches, tags, commits, diffs, file contents, code search',
    group: 'code',
    defaultChecked: true,
    scopes: ['repository'],
  },
  {
    id: 'gh-code-write',
    label: 'Create branches & commit files',
    hint: 'Create and delete branches, commit file changes (org read-only mode disables these regardless)',
    group: 'code',
    defaultChecked: true,
    scopes: ['repository:write'],
  },
  {
    id: 'gh-pr-read',
    label: 'Read pull requests',
    hint: 'Pull requests, their diffs, comments, and combined check status',
    group: 'prs',
    defaultChecked: true,
    scopes: ['pullrequest'],
  },
  {
    id: 'gh-pr-write',
    label: 'Create & act on pull requests',
    hint: 'Create, update, comment, approve, request changes, merge, close',
    group: 'prs',
    defaultChecked: true,
    scopes: ['pullrequest:write'],
  },
  {
    id: 'gh-actions-read',
    label: 'Read Actions',
    hint: 'Workflows, their runs, jobs, and logs',
    group: 'actions',
    defaultChecked: true,
    scopes: ['actions'],
  },
  {
    id: 'gh-actions-write',
    label: 'Run & cancel workflows',
    hint: 'Dispatch a workflow run on a branch or tag, cancel a running one',
    group: 'actions',
    defaultChecked: true,
    scopes: ['actions:write'],
  },
  {
    id: 'gh-admin',
    label: 'Manage repository access',
    hint: 'List and change a repository’s collaborators and their permission level',
    group: 'admin',
    // Admin powers: present in the catalog so an org can offer them, but
    // never granted by silence.
    defaultChecked: false,
    scopes: ['repository:admin'],
  },
];

/** Every scope this catalog knows, across its bundles. */
export const ALL_GITHUB_SCOPES = [...new Set(GITHUB_SCOPE_OPTIONS.flatMap((o) => o.scopes))];

export const DEFAULT_GITHUB_SCOPES = [
  ...new Set(
    GITHUB_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
].join(' ');

/**
 * The org's usable ceiling from a stored scopes string, the same
 * fall-back-to-defaults-on-drift shape as usableAtlassianCeiling.
 */
export function usableGitHubCeiling(stored: string | null | undefined): string[] {
  const known = new Set(ALL_GITHUB_SCOPES);
  const kept = (stored ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((scope) => known.has(scope));
  return kept.length > 0 ? kept : DEFAULT_GITHUB_SCOPES.split(' ');
}
