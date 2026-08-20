/**
 * How the jira_ tools reach Jira — injected, not read off
 * `context.accessToken`/`context.apiBaseUrl` inline.
 *
 * Same full shape as JsmAuth/JsmOpsAuth/WebexAuth/ZoomAuth:
 * fetch(requiredScopes, path, init) wraps the scope check around the real
 * call, because `jiraFetch` (../common.ts) already combined "use the
 * caller's credential" and "make the call" into one function. `jiraFetch`
 * throws JiraApiError on any non-2xx response by design (see its own
 * docblock) — so a `Response` this interface hands back with
 * `.ok === false` is ALWAYS this module's own `authFailure()`, never a real
 * Atlassian answer; a real API failure still surfaces by throwing.
 */

import { authFailure } from '../auth-support';
import { jiraFetch } from '../common';
import type { MCPToolContext } from '../common';

export interface JiraAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'pat';
  fetch(requiredScopes: readonly string[], path: string, init?: RequestInit): Promise<Response>;
}

/** Production's only implementation: the caller's own Jira grant. */
export function oauthJiraAuth(context: MCPToolContext): JiraAuth {
  const granted = context.grantedScopes === undefined ? null : new Set(context.grantedScopes);
  return {
    kind: 'oauth',
    async fetch(requiredScopes, path, init) {
      if (granted) {
        const missing = requiredScopes.filter((scope) => !granted.has(scope));
        if (missing.length > 0) {
          return authFailure(
            `This call needs ${missing.join(', ')}, which this connection's grant does not carry. Reconnect Jira with that scope enabled.`,
            403
          );
        }
      }
      return jiraFetch(`${context.apiBaseUrl}${path}`, context.accessToken, init);
    },
  };
}

/** Every non-ok Response `fetch()` can return is a local denial — see the header comment. */
export async function describeJiraAuthFailure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const message =
    typeof body === 'object' && body !== null
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (body as Record<string, unknown>).message
      : undefined;
  return typeof message === 'string' && message ? message : `Jira API answered ${response.status}`;
}

/** The Jira tools that read directory data rather than work items. */
const USER_DIRECTORY_TOOLS = new Set([
  'jira_list_users',
  'jira_get_user',
  'jira_list_groups',
  'jira_list_group_members',
  'jira_get_user_groups',
]);

/** Board/sprint reads and writes go through the Jira Software API. */
const BOARD_READ_TOOLS = new Set(['jira_list_boards', 'jira_list_sprints']);
const BOARD_WRITE_TOOLS = new Set([
  'jira_create_sprint',
  'jira_complete_sprint',
  'jira_move_issue_to_sprint',
  'jira_remove_issue_from_sprint',
]);

/** Delete tools gate on their own delete:* scope — a separate bundle. */
const DELETE_TOOL_SCOPES: Record<string, string> = {
  jira_delete_issue: 'delete:issue:jira',
  jira_delete_comment: 'delete:comment:jira',
  jira_delete_filter: 'delete:filter:jira',
  jira_delete_worklog: 'delete:issue-worklog:jira',
  jira_delete_component: 'delete:project.component:jira',
  jira_delete_issue_link: 'delete:issue-link:jira',
};

/**
 * Watches change Renkei's own indexing config, never Jira — so they gate on
 * read access alone. Requiring write:issue:jira would deny them to a
 * read-only Jira grant, which is exactly the grant that most wants search.
 */
const WATCH_TOOLS = new Set(['jira_watch_project', 'jira_unwatch_project', 'jira_list_watches']);

/**
 * Granular Jira scope resolution, keyed on one MARKER scope per capability
 * bundle (lib/atlassian-scopes.ts): bundles travel whole, so a bundle's
 * presence is provable from any one of its scopes. read:issue:jira marks the
 * read bundle, write:issue:jira the write bundle, the board scopes their
 * Jira Software bundles, and each delete tool its own delete scope.
 * Directory tools key on read:user:jira, which rides the read bundle — with
 * granular scopes there is no separate directory grant to distinguish.
 *
 * Moved here from mcp-tools/index.ts, exported so BOTH the registration-time
 * gate (withScopeGate, still wired up in index.ts) and this module's
 * call-time gate (oauthJiraAuth.fetch) check the identical mapping — two
 * copies is how the two would eventually disagree about what a tool needs.
 */
export function granularJiraScopes(toolName: string, readOnly: boolean): string[] {
  if (BOARD_READ_TOOLS.has(toolName)) return ['read:board-scope:jira-software'];
  if (BOARD_WRITE_TOOLS.has(toolName)) return ['write:board-scope:jira-software'];
  if (USER_DIRECTORY_TOOLS.has(toolName)) return ['read:user:jira'];
  if (WATCH_TOOLS.has(toolName)) return ['read:issue:jira'];
  // Project endpoints demand their COMPLETE documented granular set, not
  // just read:project:jira — Atlassian answers 401 "scope does not match"
  // if any one is absent. read:project.property:jira is named here as well
  // because it was missing from the catalog until 2026-08-12: gating on it
  // keeps the tool hidden for grants minted before that fix, which carry
  // read:project:jira and still cannot call the endpoint, instead of
  // offering a tool that can only 401 until the user reconnects.
  if (toolName === 'jira_list_projects') {
    return ['read:project:jira', 'read:project.property:jira'];
  }
  // Atlassian's attachment endpoint wants its own granular scope
  // (write:attachment:jira, docs/atlassian-granular-scopes.md), not just
  // write:issue:jira. It rides the same jira-write bundle
  // (lib/atlassian-scopes.ts), so no grant that can write issues lacks it —
  // gating on it hides the tool only from grants that would 401 anyway,
  // the jira_list_projects rule.
  if (toolName === 'jira_add_attachment') {
    return ['read:issue:jira', 'write:issue:jira', 'write:attachment:jira'];
  }
  const deleteScope = DELETE_TOOL_SCOPES[toolName];
  if (deleteScope) return ['read:issue:jira', deleteScope];
  return readOnly ? ['read:issue:jira'] : ['read:issue:jira', 'write:issue:jira'];
}
