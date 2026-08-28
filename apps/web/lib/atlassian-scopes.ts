/**
 * The Atlassian OAuth (3LO) scopes Renkei's tools actually use — all
 * GRANULAR (classic and granular scopes cannot mix in one app), grouped into
 * capability bundles rendered as checkboxes via ScopePicker. One checkbox is
 * one capability; the scopes underneath were derived per-endpoint from the
 * vendored OpenAPI specs (docs/atlassian-granular-scopes.md holds the
 * derivation and the console setup blocks). Pure data, importable from
 * client components; atlassian-app.ts re-exports the derived default.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const ATLASSIAN_SCOPE_GROUPS: ScopeGroup[] = [{ id: 'jira', label: 'Jira' }];

export const ATLASSIAN_JSM_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'jsm', label: 'Service Management' },
  { id: 'ops', label: 'Operations (alerts & on-call)' },
];

export const ATLASSIAN_CONFLUENCE_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'spaces', label: 'Spaces' },
  { id: 'content', label: 'Pages & blog posts' },
  { id: 'comments', label: 'Comments' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'structure', label: 'Databases & whiteboards' },
  { id: 'analytics', label: 'Analytics' },
];

export const ATLASSIAN_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'jira-read',
    label: 'Read work items & directory',
    hint: 'Search, issues, comments, worklogs, filters, projects, users & groups — every read tool',
    group: 'jira',
    defaultChecked: true,
    scopes: [
      'read:application-role:jira',
      'read:attachment:jira',
      'read:avatar:jira',
      'read:comment.property:jira',
      'read:comment:jira',
      'read:field-configuration:jira',
      'read:field.default-value:jira',
      'read:field.option:jira',
      'read:field:jira',
      'read:filter.default-share-scope:jira',
      'read:filter:jira',
      'read:group:jira',
      'read:issue-details:jira',
      'read:issue-link-type:jira',
      'read:issue-meta:jira',
      'read:issue-security-level:jira',
      'read:issue-type-hierarchy:jira',
      'read:issue-type:jira',
      'read:issue-worklog.property:jira',
      'read:issue-worklog:jira',
      'read:issue.changelog:jira',
      'read:issue.transition:jira',
      'read:issue.vote:jira',
      'read:issue:jira',
      'read:jql:jira',
      'read:project-category:jira',
      'read:project-role:jira',
      'read:project-version:jira',
      'read:project.component:jira',
      'read:project.property:jira',
      'read:project:jira',
      'read:status:jira',
      'read:user.property:jira',
      'read:user:jira',
    ],
  },
  {
    id: 'jira-write',
    label: 'Create & update work items',
    hint: 'Create, edit, transition, comment, attach, log work, link, web links, filters, components, versions (org read-only mode disables these regardless)',
    group: 'jira',
    defaultChecked: true,
    scopes: [
      'write:attachment:jira',
      'write:comment.property:jira',
      'write:comment:jira',
      'write:filter:jira',
      'write:issue-link:jira',
      'write:issue-worklog.property:jira',
      'write:issue-worklog:jira',
      'write:issue.property:jira',
      'write:issue.time-tracking:jira',
      'write:issue:jira',
      'write:project-version:jira',
      'write:project.component:jira',
      'write:remote-link:jira',
    ],
  },
  {
    id: 'jira-delete',
    label: 'Delete work items & data',
    hint: 'Delete issues, comments, worklogs, filters, components, issue links — all confirm-gated tools',
    group: 'jira',
    defaultChecked: true,
    scopes: [
      'delete:comment.property:jira',
      'delete:comment:jira',
      'delete:filter:jira',
      'delete:issue-link:jira',
      'delete:issue-worklog.property:jira',
      'delete:issue-worklog:jira',
      'delete:issue:jira',
      'delete:project.component:jira',
    ],
  },
  {
    id: 'boards-read',
    label: 'View boards & sprints',
    hint: 'Boards, board issues, backlog, sprints via the agile API',
    group: 'jira',
    defaultChecked: false,
    scopes: [
      'read:board-scope:jira-software',
      'read:sprint:jira-software',
      'read:issue:jira-software',
    ],
  },
  {
    id: 'boards-write',
    label: 'Manage sprints & board issues',
    hint: 'Create/complete sprints, move issues between sprint and backlog',
    group: 'jira',
    defaultChecked: false,
    scopes: ['write:board-scope:jira-software', 'write:sprint:jira-software'],
  },
];

/**
 * The second app's catalog ("Renkei JSM"): JSM + Ops. Everything defaults on
 * — a dedicated app exists to be used; the org ceiling and per-user
 * narrowing still apply.
 */
export const ATLASSIAN_JSM_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'jsm-read',
    label: 'Read requests',
    hint:
      'Requests, comments, participants, approvals, SLAs, request types, service desks, ' +
      'and the project components a request can be filed under',
    group: 'jsm',
    defaultChecked: true,
    scopes: [
      'read:request.approval:jira-service-management',
      'read:request.comment:jira-service-management',
      'read:request.participant:jira-service-management',
      'read:request.sla:jira-service-management',
      'read:request.status:jira-service-management',
      'read:request:jira-service-management',
      'read:requesttype:jira-service-management',
      'read:servicedesk:jira-service-management',
      // Cross-family on purpose: JSM request payloads embed user objects, and
      // Atlassian's all-of enforcement demands read:user:jira on most
      // servicedeskapi endpoints — so the JSM app carries this one Jira-API
      // scope too.
      'read:user:jira',
      // The second cross-family one, and for the same kind of reason: the
      // servicedeskapi has no components endpoint at all, so jsm_list_components
      // has to ask the platform for the desk's project. A grant made before
      // this was added simply lacks it — the tool still registers, and only
      // its whole-project listing answers "reconnect with that scope",
      // naming it. Passing requestTypeId takes the JSM-only path instead.
      'read:project.component:jira',
    ],
  },
  {
    id: 'jsm-write',
    label: 'Create & update requests',
    hint: 'Create requests, comment, attach, transition, manage participants (approvals stay read-only by design)',
    group: 'jsm',
    defaultChecked: true,
    scopes: [
      'read:request.attachment:jira-service-management',
      'write:request.attachment:jira-service-management',
      'write:request.comment:jira-service-management',
      'write:request.participant:jira-service-management',
      'write:request.status:jira-service-management',
      'write:request:jira-service-management',
      'delete:request.participant:jira-service-management',
      'read:user:jira',
      // Two more cross-family scopes, same reasoning as the reads above:
      // the servicedeskapi cannot set an assignee at all, nor a priority,
      // story points, an estimate, or a custom field the request form does
      // not carry — so jsm_create_request finishes them with one platform
      // edit right after the create, and resolving field names to ids for
      // that edit reads the platform field schema. A grant made before
      // these were added simply lacks them — the request is still created,
      // and the reply names the scope as the fix for the field that did
      // not stick.
      'write:issue:jira',
      'read:issue:jira',
    ],
  },
  {
    id: 'jsm-customers',
    label: 'Manage customers',
    hint: 'List, create, invite, and remove service desk customers',
    group: 'jsm',
    defaultChecked: true,
    scopes: [
      'read:customer:jira-service-management',
      'write:customer:jira-service-management',
      'read:servicedesk.customer:jira-service-management',
      'write:servicedesk.customer:jira-service-management',
      'delete:servicedesk.customer:jira-service-management',
      'read:user:jira',
    ],
  },
  {
    id: 'ops-alerts-read',
    label: 'Read alerts',
    hint: 'Alert list and detail',
    group: 'ops',
    defaultChecked: true,
    scopes: ['read:ops-alert:jira-service-management'],
  },
  {
    id: 'ops-alerts-write',
    label: 'Act on alerts',
    hint: 'Acknowledge and close',
    group: 'ops',
    defaultChecked: true,
    scopes: ['write:ops-alert:jira-service-management'],
  },
  {
    id: 'ops-config-read',
    label: 'Read schedules & on-call',
    hint: 'Schedules, rotations, who-is-on-call, teams, escalations',
    group: 'ops',
    defaultChecked: true,
    scopes: ['read:ops-config:jira-service-management'],
  },
  {
    id: 'ops-config-write',
    label: 'Update schedules',
    hint: 'Overrides and rotation changes — confirm-gated wizards',
    group: 'ops',
    defaultChecked: true,
    scopes: ['write:ops-config:jira-service-management'],
  },
  {
    id: 'ops-config-delete',
    label: 'Delete overrides',
    hint: 'Remove schedule overrides — confirm-gated',
    group: 'ops',
    defaultChecked: true,
    scopes: ['delete:ops-config:jira-service-management'],
  },
];

/**
 * The third app's catalog ("Renkei Confluence"): Confluence's own product
 * API, its own dedicated app — unlike JSM this isn't the same site's API,
 * so nothing here shares a scope family with the other two catalogs.
 * Derivation: docs/atlassian-confluence-granular-scopes.md (a few scope
 * names are flagged there as unverified against the actual console — this
 * is a brand-new app, so that's the authoritative source at setup time).
 */
export const ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'confluence-spaces',
    label: 'View spaces',
    hint: 'confluence_list_spaces, confluence_get_space — including space permissions',
    userHint: 'See the Confluence spaces you have access to, and who else can view them.',
    group: 'spaces',
    defaultChecked: true,
    scopes: ['read:space:confluence', 'read:space.permission:confluence'],
  },
  {
    id: 'confluence-content-read',
    label: 'Read pages & blog posts',
    hint: 'List/get pages and blog posts, version history, drafts',
    group: 'content',
    defaultChecked: true,
    scopes: ['read:page:confluence', 'read:blogpost:confluence'],
  },
  {
    id: 'confluence-content-write',
    label: 'Create, edit & move pages/blog posts',
    hint: 'Create, edit (Markdown in, rendered content out), move, and set status — never "archived", which Confluence’s API silently no-ops on',
    group: 'content',
    defaultChecked: true,
    scopes: ['write:page:confluence', 'write:blogpost:confluence'],
  },
  {
    id: 'confluence-content-delete',
    label: 'Delete pages & blog posts',
    hint: 'Trash (and purge) pages and blog posts',
    group: 'content',
    defaultChecked: true,
    scopes: ['delete:page:confluence', 'delete:blogpost:confluence'],
  },
  {
    id: 'confluence-search',
    label: 'Search & look up users',
    hint: 'confluence_search (full-text/CQL) and confluence_search_users (for tagging/mentions)',
    userHint: 'Search Confluence content, and look up colleagues so they can be mentioned.',
    group: 'content',
    defaultChecked: true,
    scopes: ['read:content-details:confluence'],
  },
  {
    id: 'confluence-labels',
    label: 'Manage labels',
    hint: 'List, add, and remove labels on pages/blog posts/attachments',
    group: 'content',
    defaultChecked: true,
    scopes: ['read:label:confluence', 'write:label:confluence'],
  },
  {
    id: 'confluence-tasks',
    label: 'Read & update tasks',
    hint: 'List inline tasks and change their status — tasks are authored via "- [ ]" Markdown in a page, not created through this API',
    group: 'content',
    defaultChecked: true,
    scopes: ['read:task:confluence', 'write:task:confluence'],
  },
  {
    id: 'confluence-properties',
    label: 'Read & set page metadata',
    hint: 'Arbitrary content-property metadata on a page, separate from its body',
    group: 'content',
    defaultChecked: true,
    scopes: ['read:content.property:confluence', 'write:content.property:confluence'],
  },
  {
    id: 'confluence-comments-read',
    label: 'Read comments',
    hint: 'Footer and inline comments on pages/blog posts',
    group: 'comments',
    defaultChecked: true,
    scopes: ['read:comment:confluence'],
  },
  {
    id: 'confluence-comments-write',
    label: 'Add & edit comments',
    hint: 'Footer and inline comments, including threaded replies',
    group: 'comments',
    defaultChecked: true,
    scopes: ['write:comment:confluence'],
  },
  {
    id: 'confluence-comments-delete',
    label: 'Delete comments',
    hint: 'Remove a comment',
    group: 'comments',
    defaultChecked: true,
    scopes: ['delete:comment:confluence'],
  },
  {
    id: 'confluence-attachments-read',
    label: 'Read attachments',
    hint: 'List attachments on a page/blog post',
    group: 'attachments',
    defaultChecked: true,
    scopes: ['read:attachment:confluence'],
  },
  {
    id: 'confluence-attachments-write',
    label: 'Upload attachments',
    hint: 'Upload a file to a page/blog post',
    group: 'attachments',
    defaultChecked: true,
    scopes: ['write:attachment:confluence'],
  },
  {
    id: 'confluence-attachments-delete',
    label: 'Delete attachments',
    hint: 'Remove an attachment',
    group: 'attachments',
    defaultChecked: true,
    scopes: ['delete:attachment:confluence'],
  },
  {
    id: 'confluence-databases',
    label: 'Manage databases (metadata only)',
    hint: 'Create/read/delete a database’s title and location — there is no API for its rows or columns',
    group: 'structure',
    defaultChecked: false,
    scopes: ['read:database:confluence', 'write:database:confluence', 'delete:database:confluence'],
  },
  {
    id: 'confluence-whiteboards',
    label: 'Manage whiteboards (metadata only)',
    hint: 'Create/read/delete a whiteboard’s title and location — there is no API for its canvas content',
    group: 'structure',
    defaultChecked: false,
    scopes: [
      'read:whiteboard:confluence',
      'write:whiteboard:confluence',
      'delete:whiteboard:confluence',
    ],
  },
  {
    id: 'confluence-analytics',
    label: 'Page view analytics',
    hint: 'Per-page view/viewer counts — there is no space-level analytics API to read instead',
    group: 'analytics',
    defaultChecked: false,
    scopes: ['read:analytics.content:confluence'],
  },
];

/**
 * The fourth catalog ("Renkei Bitbucket"): Bitbucket Cloud, an Atlassian
 * product on its own OAuth system — consumers live on bitbucket.org, not
 * the 3LO platform, and scopes are FIXED ON THE CONSUMER: the authorize
 * step cannot narrow them, so these checkboxes shape requested_scopes and
 * the tools register on requested ∩ granted (the Zoom arrangement).
 * Scope-per-endpoint derivation:
 * docs/bitbucket-cloud-rest-api-open-api-spec.json.
 */
export const ATLASSIAN_BITBUCKET_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'code', label: 'Repositories & code' },
  { id: 'prs', label: 'Pull requests' },
  { id: 'pipelines', label: 'Pipelines' },
];

export const ATLASSIAN_BITBUCKET_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'bb-code-read',
    label: 'Read repositories & code',
    hint: 'Workspaces, projects, repositories, branches, tags, commits, diffs, file contents, code search',
    group: 'code',
    defaultChecked: true,
    // `project` rides along: the workspace project listing is the only
    // thing that needs it, and offering it as its own checkbox would be a
    // switch whose whole effect is hiding one list tool.
    scopes: ['repository', 'project'],
  },
  {
    id: 'bb-code-write',
    label: 'Create branches & commit files',
    hint: 'Create and delete branches, commit file changes (org read-only mode disables these regardless)',
    group: 'code',
    defaultChecked: true,
    scopes: ['repository:write'],
  },
  {
    id: 'bb-pr-read',
    label: 'Read pull requests',
    hint: 'Pull requests, their diffs, comments, tasks and build statuses',
    group: 'prs',
    defaultChecked: true,
    scopes: ['pullrequest'],
  },
  {
    id: 'bb-pr-write',
    label: 'Create & act on pull requests',
    hint: 'Create, update, comment, approve, request changes, merge, decline',
    group: 'prs',
    defaultChecked: true,
    scopes: ['pullrequest:write'],
  },
  {
    id: 'bb-admin',
    label: 'Administer projects & repository access',
    hint: 'Create, rename and delete projects; grant and revoke per-repository access for workspace members and groups (project-level permission changes are refused for OAuth by Bitbucket itself)',
    group: 'code',
    // Admin powers: present in the catalog so an org can offer them, but
    // never granted by silence.
    defaultChecked: false,
    scopes: ['project:admin', 'repository:admin'],
  },
  {
    id: 'bb-pipelines-read',
    label: 'Read pipelines',
    hint: 'Pipeline runs, their steps, and step logs',
    group: 'pipelines',
    defaultChecked: true,
    scopes: ['pipeline'],
  },
  {
    id: 'bb-pipelines-write',
    label: 'Run & stop pipelines',
    hint: 'Trigger a pipeline on a branch or commit, stop a running one',
    group: 'pipelines',
    defaultChecked: true,
    scopes: ['pipeline:write'],
  },
];

/**
 * Always requested, never a choice: without offline_access Atlassian issues
 * no refresh token, and every grant would die within an hour of connecting.
 */
export const ATLASSIAN_OFFLINE_SCOPE = 'offline_access';
export const ATLASSIAN_REQUIRED_SCOPES = [ATLASSIAN_OFFLINE_SCOPE];

/**
 * Bitbucket's equivalent of the always-on scope, with a different reason:
 * `account` is what GET /2.0/user needs, and that call is how a connect
 * learns whose grant it just stored. No offline_access exists on Bitbucket —
 * refresh tokens are always issued.
 */
export const BITBUCKET_ACCOUNT_SCOPE = 'account';
export const BITBUCKET_REQUIRED_SCOPES = [BITBUCKET_ACCOUNT_SCOPE];

/** Every scope each catalog knows, across its bundles. */
export const ALL_ATLASSIAN_SCOPES = [
  ...new Set(ATLASSIAN_SCOPE_OPTIONS.flatMap((option) => option.scopes)),
];
export const ALL_ATLASSIAN_JSM_SCOPES = [
  ...new Set(ATLASSIAN_JSM_SCOPE_OPTIONS.flatMap((option) => option.scopes)),
];
export const ALL_ATLASSIAN_CONFLUENCE_SCOPES = [
  ...new Set(ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS.flatMap((option) => option.scopes)),
];
export const ALL_ATLASSIAN_BITBUCKET_SCOPES = [
  ...new Set([
    ...ATLASSIAN_BITBUCKET_SCOPE_OPTIONS.flatMap((option) => option.scopes),
    BITBUCKET_ACCOUNT_SCOPE,
  ]),
];

export const DEFAULT_ATLASSIAN_SCOPES = [
  ...new Set(
    ATLASSIAN_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
  ATLASSIAN_OFFLINE_SCOPE,
].join(' ');

export const DEFAULT_ATLASSIAN_JSM_SCOPES = [
  ...new Set(
    ATLASSIAN_JSM_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
  ATLASSIAN_OFFLINE_SCOPE,
].join(' ');

export const DEFAULT_ATLASSIAN_CONFLUENCE_SCOPES = [
  ...new Set(
    ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
  ATLASSIAN_OFFLINE_SCOPE,
].join(' ');

export const DEFAULT_ATLASSIAN_BITBUCKET_SCOPES = [
  ...new Set(
    ATLASSIAN_BITBUCKET_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
  BITBUCKET_ACCOUNT_SCOPE,
].join(' ');

/**
 * The org's usable ceiling from a stored scopes string. Settings saved before
 * the granular migration hold classic scopes the catalog no longer knows —
 * filtering to known scopes and falling back to the default set keeps those
 * orgs connectable (at defaults) until an admin re-saves Connector setup.
 */
export function usableAtlassianCeiling(stored: string | null | undefined): string[] {
  return usableCeiling(stored, ALL_ATLASSIAN_SCOPES, DEFAULT_ATLASSIAN_SCOPES);
}

export function usableAtlassianJsmCeiling(stored: string | null | undefined): string[] {
  return usableCeiling(stored, ALL_ATLASSIAN_JSM_SCOPES, DEFAULT_ATLASSIAN_JSM_SCOPES);
}

export function usableAtlassianConfluenceCeiling(stored: string | null | undefined): string[] {
  return usableCeiling(
    stored,
    ALL_ATLASSIAN_CONFLUENCE_SCOPES,
    DEFAULT_ATLASSIAN_CONFLUENCE_SCOPES
  );
}

export function usableAtlassianBitbucketCeiling(stored: string | null | undefined): string[] {
  return usableCeiling(stored, ALL_ATLASSIAN_BITBUCKET_SCOPES, DEFAULT_ATLASSIAN_BITBUCKET_SCOPES);
}

function usableCeiling(
  stored: string | null | undefined,
  catalog: readonly string[],
  fallback: string
): string[] {
  const known = new Set(catalog);
  const kept = (stored ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((scope) => known.has(scope));
  return kept.length > 0 ? kept : fallback.split(' ');
}
