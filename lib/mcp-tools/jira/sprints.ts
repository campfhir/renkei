/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Sprint and board management tools for Jira MCP.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, sprintUrl, getCachedDisplayName } from '../common';
import { loadFieldSchema, lookupField } from './field-schema';
import { logger } from '@/lib/logger';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nameOf = (value: unknown): string =>
  isRecord(value) && typeof value.name === 'string' ? value.name : '';

export interface SprintMembership {
  /** False when neither source could answer; the caller must not read absence as "no sprint". */
  resolved: boolean;
  /** Sprints the issue is in now. More than one is possible across boards. */
  active: string[];
  /** Sprints it was in, which stay on the issue and are not something to remove. */
  closed: string[];
}

/**
 * Which sprints an issue belongs to.
 *
 * The Agile API answers this directly: its issue resource returns the agile
 * fields — `sprint`, `closedSprints`, `epic` — so nothing has to know the
 * per-instance customfield id that the Jira API would need. That id is the
 * fallback, for a site where the Agile API is unavailable.
 */
export async function sprintMembership(
  context: MCPToolContext,
  issueKey: string
): Promise<SprintMembership> {
  try {
    const response = await jiraFetch(
      `${context.apiBaseUrl}/rest/agile/1.0/issue/${encodeURIComponent(issueKey)}`,
      context.accessToken
    );
    const issue = await response.json();
    const fields = isRecord(issue) && isRecord(issue.fields) ? issue.fields : {};

    const active = nameOf(fields.sprint) ? [nameOf(fields.sprint)] : [];
    const closed = Array.isArray(fields.closedSprints)
      ? fields.closedSprints.map(nameOf).filter(Boolean)
      : [];

    return { resolved: true, active, closed };
  } catch (error) {
    logger.debug('[Sprint] Agile issue lookup failed, trying the Sprint field', {
      issueKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fallback: read the Sprint customfield, resolved by name against this site.
  // It mixes active and closed sprints in one array, so everything found is
  // reported as active — a removal attempt is then the thing that decides.
  try {
    const field = lookupField(await loadFieldSchema(context), 'Sprint');
    if (!field.ok) return { resolved: false, active: [], closed: [] };

    const response = await jiraFetch(
      `${context.apiBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${field.field.id}`,
      context.accessToken
    );
    const issue = await response.json();
    const value =
      isRecord(issue) && isRecord(issue.fields) ? issue.fields[field.field.id] : undefined;
    const active = Array.isArray(value) ? value.map(nameOf).filter(Boolean) : [];

    return { resolved: true, active, closed: [] };
  } catch {
    return { resolved: false, active: [], closed: [] };
  }
}

/**
 * The boards this issue's project has, as `name (id)`.
 *
 * Answers the question that follows "it is not in a sprint": if someone is
 * looking at it on a board, this is where to look. Best-effort — an empty list
 * means either no boards or no answer, and the caller says so rather than
 * asserting the project has none.
 */
export async function projectBoards(context: MCPToolContext, issueKey: string): Promise<string[]> {
  const projectKey = issueKey.split('-')[0];
  if (!projectKey) return [];

  try {
    const response = await jiraFetch(
      `${context.apiBaseUrl}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
      context.accessToken
    );
    const payload = await response.json();
    const values = isRecord(payload) && Array.isArray(payload.values) ? payload.values : [];

    return values
      .filter(isRecord)
      .map((board) => `${nameOf(board)} (${String(board.id ?? '?')})`)
      .filter((label) => !label.startsWith(' ('));
  } catch {
    return [];
  }
}

export async function registerSprintTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // create_sprint
  server.registerTool(
    'create_sprint',
    {
      title: 'Create a sprint',
      description: 'Create a new sprint on a Jira Software board.',
      inputSchema: z.object({
        boardId: z.string().describe('Board ID'),
        name: z.string().describe('Sprint name'),
        startDate: z.string().describe('Sprint start date (ISO format, optional)').optional(),
        endDate: z.string().describe('Sprint end date (ISO format, optional)').optional(),
        goal: z.string().describe('Sprint goal (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] create_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { boardId, name, startDate, endDate, goal } = args;

        if (!boardId || !name) {
          return {
            content: [{ type: 'text' as const, text: 'boardId and name are required' }],
            isError: true,
          };
        }

        const body: any = { name, originBoardId: parseInt(String(boardId)) };
        if (startDate) body.startDate = startDate;
        if (endDate) body.endDate = endDate;
        if (goal) body.goal = goal;

        await jiraFetch(`${context.apiBaseUrl}/rest/agile/1.0/sprint`, context.accessToken, {
          method: 'POST',
          body: JSON.stringify(body),
        });

        const text = `Created sprint "${name}"\n\n[Open in Jira](${sprintUrl(context.siteUrl, String(boardId))})`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // move_issue_to_sprint
  server.registerTool(
    'move_issue_to_sprint',
    {
      title: 'Move a Jira issue to a sprint',
      description:
        'Move an issue into a sprint. Uses the Agile API, so it works whether or not the ' +
        "project's edit screen exposes the Sprint field.",
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        sprintId: z.string().describe('Target sprint ID'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] move_issue_to_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, sprintId } = args;

        if (!issueKey || !sprintId) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and sprintId are required' }],
            isError: true,
          };
        }

        // The Agile API owns sprint membership. This used to PUT
        // `fields: { sprint: sprintId }` on the issue, which cannot work: `sprint`
        // is not a field id — it is a per-instance customfield — so Jira answered
        // "Field 'sprint' cannot be set. It is not on the appropriate screen, or
        // unknown" on every project, and the real reason was unguessable from it.
        await jiraFetch(
          `${context.apiBaseUrl}/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}/issue`,
          context.accessToken,
          { method: 'POST', body: JSON.stringify({ issues: [String(issueKey)] }) }
        );

        return {
          content: [{ type: 'text' as const, text: `Moved ${issueKey} to sprint ${sprintId}` }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // remove_issue_from_sprint
  server.registerTool(
    'remove_issue_from_sprint',
    {
      title: 'Remove an issue from a sprint',
      description:
        'Move an issue out of its sprint and back to the backlog. Reports which sprint it left, ' +
        'and says so plainly when the issue is not in one.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] remove_issue_from_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        // Which sprint, if any, before changing anything. "It is not in a sprint"
        // is the answer to this request as often as a removal is, and attempting
        // the move first turned that answer into a confusing rejection.
        const membership = await sprintMembership(context, String(issueKey));

        if (membership.resolved && membership.active.length === 0) {
          const boards = await projectBoards(context, String(issueKey));
          const lines = [`${issueKey} is not in a sprint, so there is nothing to remove it from.`];

          if (membership.closed.length > 0) {
            lines.push(
              `It was in ${membership.closed.join(', ')}, now closed — closed sprints stay on the issue as history.`
            );
          }
          if (boards.length > 0) {
            // The follow-up question this otherwise leaves hanging: if someone
            // sees it on a board, these are the boards it could be on.
            lines.push(`Boards in this project: ${boards.join(', ')}.`);
          }

          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        // Moving to the backlog is how the Agile API removes sprint membership.
        // The old PUT of `fields: { sprint: null }` named a field that does not
        // exist and failed everywhere.
        await jiraFetch(`${context.apiBaseUrl}/rest/agile/1.0/backlog/issue`, context.accessToken, {
          method: 'POST',
          body: JSON.stringify({ issues: [String(issueKey)] }),
        });

        const left =
          membership.active.length > 0 ? ` (was in ${membership.active.join(', ')})` : '';
        return {
          content: [{ type: 'text' as const, text: `Moved ${issueKey} to the backlog${left}` }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // complete_sprint
  server.registerTool(
    'complete_sprint',
    {
      title: 'Complete a Scrum sprint',
      description: 'Complete (close) a sprint.',
      inputSchema: z.object({
        boardId: z.string().describe('Board ID'),
        sprintId: z.string().describe('Sprint ID to complete'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] complete_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { sprintId } = args;

        if (!sprintId) {
          return {
            content: [{ type: 'text' as const, text: 'sprintId is required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/agile/1.0/sprint/${sprintId}`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({ state: 'closed' }),
          }
        );

        return { content: [{ type: 'text' as const, text: `Completed sprint ${sprintId}` }] };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );
}
