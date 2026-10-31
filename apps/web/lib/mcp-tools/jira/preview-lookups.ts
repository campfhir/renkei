/**
 * The names behind the ids a Jira act's preview card carries (see
 * ../lookup.ts). Each lookup only reads, and a failure just leaves the name
 * out — the card then says "the sprint" rather than an id.
 */

import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, text, type Args, type Names } from '../previews/card';
import { granularJiraScopes, type JiraAuth } from './jira-auth';

const EXCERPT = 80;

export function registerJiraPreviewLookups(context: MCPToolContext, auth: JiraAuth): void {
  const get = async (scopeTool: string, path: string): Promise<Args | null> => {
    try {
      const response = await auth.fetch(granularJiraScopes(scopeTool, true), path);
      if (!response.ok) return null;
      return record(await response.json());
    } catch {
      return null;
    }
  };
  const issueRead = (path: string) => get('jira_get_issue', path);
  const id = (value: unknown) => encodeURIComponent(text(value));

  const sprint = async (sprintId: unknown, boardId?: unknown): Promise<Names> => {
    const found = text(sprintId)
      ? await get('jira_list_sprints', `/rest/agile/1.0/sprint/${id(sprintId)}`)
      : null;
    const boardRef = text(boardId) || text(found?.originBoardId);
    const board = boardRef
      ? await get('jira_list_boards', `/rest/agile/1.0/board/${id(boardRef)}`)
      : null;
    return {
      ...(text(found?.name) ? { [nameKey('sprint', text(sprintId))]: text(found?.name) } : {}),
      ...(text(board?.name) ? { [nameKey('board', boardRef)]: text(board?.name) } : {}),
    };
  };

  const component = async (componentId: unknown): Promise<Names> => {
    const found = text(componentId)
      ? await get('jira_get_component', `/rest/api/3/component/${id(componentId)}`)
      : null;
    return text(found?.name)
      ? { [nameKey('component', text(componentId))]: text(found?.name) }
      : {};
  };

  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  registerPreviewLookups(context, {
    jira_create_sprint: async (args) => sprint('', args.boardId),
    jira_complete_sprint: async (args) => sprint(args.sprintId, args.boardId),
    jira_move_issue_to_sprint: async (args) => sprint(args.sprintId),
    jira_bulk_move_sprint_issues: async (args) => sprint(args.sprintId),

    jira_delete_component: async (args) =>
      merge(component(args.componentId), component(args.moveIssuesTo)),

    jira_delete_filter: async (args) => {
      const found = text(args.filterId)
        ? await get('jira_get_filter', `/rest/api/3/filter/${id(args.filterId)}`)
        : null;
      return text(found?.name)
        ? { [nameKey('filter', text(args.filterId))]: text(found?.name) }
        : {};
    },

    // A comment has no name: who wrote it and how it starts is what a person recognises.
    jira_update_comment: async (args) => commentName(args),
    jira_delete_comment: async (args) => commentName(args),

    jira_delete_worklog: async (args) => {
      const found = await issueRead(
        `/rest/api/3/issue/${id(args.issueKey)}/worklog/${id(args.worklogId)}`
      );
      if (!found) return {};
      const author = text(record(found.author).displayName);
      const spent = text(found.timeSpent);
      const label = [spent, author ? `by ${author}` : ''].filter(Boolean).join(' ');
      return label ? { [nameKey('worklog', text(args.worklogId))]: label } : {};
    },

    jira_delete_issue_link: async (args) => {
      const found = await issueRead(`/rest/api/3/issueLink/${id(args.linkId)}`);
      if (!found) return {};
      const from = text(record(found.outwardIssue).key);
      const to = text(record(found.inwardIssue).key);
      const type = text(record(found.type).outward) || text(record(found.type).name);
      return from && to
        ? { [nameKey('link', text(args.linkId))]: `${from} ${type} ${to}`.replace(/\s+/g, ' ') }
        : {};
    },
  });

  async function commentName(args: Args): Promise<Names> {
    const found = await issueRead(
      `/rest/api/3/issue/${id(args.issueKey)}/comment/${id(args.commentId)}`
    );
    if (!found) return {};
    const author = text(record(found.author).displayName);
    const body = adfText(found.body).replace(/\s+/g, ' ').trim();
    const excerpt = body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body;
    const label = [author ? `by ${author}` : '', excerpt ? `“${excerpt}”` : '']
      .filter(Boolean)
      .join(': ');
    return label ? { [nameKey('comment', text(args.commentId))]: label } : {};
  }
}

/** The plain text of an Atlassian document (or a string body), depth-first. */
function adfText(node: unknown): string {
  if (typeof node === 'string') return node;
  const value = record(node);
  const own = typeof value.text === 'string' ? value.text : '';
  const children = Array.isArray(value.content) ? value.content.map(adfText).join(' ') : '';
  return `${own}${children}`;
}
