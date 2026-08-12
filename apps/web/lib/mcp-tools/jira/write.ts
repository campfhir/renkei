/**
 * Write tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, issueUrl, getCachedDisplayName } from '../common';
import { markdownToAdf } from './markdown';
import {
  buildFieldUpdates,
  findStoryPointsField,
  isJiraDuration,
  loadFieldSchema,
} from './field-schema';
import { renderFieldValue } from './fields';
import {
  unwrittenFieldsComment,
  writeWithFieldFallback,
  type FieldWritePlan,
  type UnwrittenField,
} from './field-write';
import { logger } from '@/lib/logger';

// Type guard functions
/**
 * Resolve an assignee argument to an Atlassian accountId. Jira Cloud dropped
 * name/email user identification in field objects (GDPR): `{ name: ... }` is
 * silently ignored, which made create/update claim an assignee was set while
 * writing nothing. An accountId-shaped value passes through; anything else
 * goes through user search and must match exactly one user — ambiguity or a
 * miss becomes an unwritten value, reported, never a silent no-op.
 */
async function resolveAssigneeId(
  context: MCPToolContext,
  value: string
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!value.includes('@') && /^[0-9a-zA-Z:-]{16,128}$/.test(value)) {
    return { ok: true, id: value };
  }
  const response = await jiraFetch(
    `${context.apiBaseUrl}/rest/api/3/user/search?query=${encodeURIComponent(value)}`,
    context.accessToken
  );
  const users: unknown = await response.json().catch(() => null);
  const candidates = Array.isArray(users)
    ? users.filter(isRecord).filter((u) => isString(u.accountId))
    : [];
  const exact = candidates.filter(
    (u) => isString(u.emailAddress) && u.emailAddress.toLowerCase() === value.toLowerCase()
  );
  const pick = exact.length > 0 ? exact : candidates;
  if (pick.length === 1) return { ok: true, id: String(pick[0].accountId) };
  if (pick.length === 0) return { ok: false, reason: `no Jira user matches "${value}"` };
  return {
    ok: false,
    reason: `"${value}" matches ${pick.length} users — pass an accountId (jira_search_users shows them)`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The extra-field arguments jira_create_issue and jira_update_issue both accept. */
const extraFieldSchema = {
  storyPoints: z
    .number()
    .describe(
      'Story point estimate. The field is found by name on this site, whether it is called ' +
        '"Story Points" or "Story point estimate".'
    )
    .optional(),
  originalEstimate: z
    .string()
    .describe('Original time estimate in Jira duration form, e.g. "3d", "4h", "1w 2d"')
    .optional(),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'Any other fields, keyed by name or id: {"Decision of Change Request": "Approved", ' +
        '"customfield_12016": 3}. Values are shaped to match each field\'s schema — a select ' +
        'field gets {value: …}, a number gets a number — so pass the plain value.'
    )
    .optional(),
};

interface ExtraFields {
  /** Resolved and shaped, keyed by field id. Droppable. */
  fields: Record<string, unknown>;
  /** Field id -> `Story Points → 5`. */
  labels: Record<string, string>;
  /** Field id -> valid options, for refusal messages the caller can act on. */
  hints: Record<string, string>;
  /** Values that never reached a request: unresolvable names, bad formats. */
  unwritten: UnwrittenField[];
}

/**
 * Turn the extra-field arguments into something sendable.
 *
 * Nothing here can fail the call. A name this site does not have, or a duration
 * Jira would not parse, becomes an unwritten value to record rather than a
 * refusal — the issue is worth creating either way, and the reply says plainly
 * what did not land.
 */
async function collectExtraFields(
  context: MCPToolContext,
  args: Record<string, unknown>,
  options: { projectKey?: string; issueType?: string; issueKey?: string } = {}
): Promise<ExtraFields> {
  const fields: Record<string, unknown> = {};
  const labels: Record<string, string> = {};
  const hints: Record<string, string> = {};
  const unwritten: UnwrittenField[] = [];

  if (isNumber(args.storyPoints)) {
    const label = `Story points → ${args.storyPoints}`;
    // The id differs per site, so it is looked up by name rather than assumed.
    const lookup = findStoryPointsField(await loadFieldSchema(context));
    if (lookup.ok) {
      fields[lookup.field.id] = args.storyPoints;
      labels[lookup.field.id] = `${lookup.field.name} → ${args.storyPoints}`;
    } else {
      unwritten.push({ label, reason: lookup.message });
    }
  }

  if (isString(args.originalEstimate)) {
    const label = `Original estimate → ${args.originalEstimate}`;
    if (isJiraDuration(args.originalEstimate)) {
      // A partial timetracking object leaves the remaining estimate alone,
      // which is what setting only the original is meant to do.
      fields.timetracking = { originalEstimate: args.originalEstimate };
      labels.timetracking = label;
    } else {
      unwritten.push({
        label,
        reason: 'not a Jira duration — expected something like "3d", "4h" or "1w 2d"',
      });
    }
  }

  if (isRecord(args.fields)) {
    const updates = await buildFieldUpdates(context, args.fields, options);
    Object.assign(fields, updates.fields);
    Object.assign(hints, updates.optionHints);
    for (const [id, value] of Object.entries(updates.fields)) {
      const applied = updates.applied.find((entry) => entry.includes(id));
      // The rendered text, not the JSON. When a write is refused this label is
      // what the fallback comment carries, and it recorded "[object Object]"
      // for every rich-text field — losing exactly the value the comment
      // exists to preserve.
      labels[id] = `${applied ?? id} → ${preview(value)}`;
    }
    for (const problem of updates.problems) {
      unwritten.push({ label: 'A field that could not be resolved', reason: problem });
    }
  }

  return { fields, labels, hints, unwritten };
}

/**
 * Leave the unwritten values on the issue as a comment.
 *
 * A failure here is reported but never raised: the issue was written, and losing
 * the note is not worth undoing that.
 */
export async function recordUnwritten(
  context: MCPToolContext,
  issueKey: string,
  unwritten: readonly UnwrittenField[]
): Promise<boolean> {
  try {
    await jiraFetch(
      `${context.apiBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      context.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ body: markdownToAdf(unwrittenFieldsComment(unwritten)) }),
      }
    );
    return true;
  } catch (error) {
    logger.warn('could not record unwritten fields', {
      component: 'mcp/tool',
      tenantId: context.tenantId,
      issueKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** How long a value may run before the reply and the comment truncate it. */
const PREVIEW_CHARS = 300;

/**
 * A readable one-line rendering of a value about to be written.
 *
 * Goes through the same renderer the read path uses, so an Atlassian Document
 * shows its text rather than its node tree.
 */
function preview(value: unknown): string {
  const text = renderFieldValue(value)
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
  if (!text) return '(empty)';
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** The trailing section of a reply: what was set, and what was not. */
function describeOutcome(
  applied: readonly string[],
  unwritten: readonly UnwrittenField[],
  commented: boolean
): string {
  const lines: string[] = [];

  if (applied.length > 0) {
    lines.push('', ...applied.map((entry) => `• ${entry}`));
  }

  if (unwritten.length > 0) {
    lines.push(
      '',
      commented
        ? 'Not set (recorded as a comment on the issue):'
        : 'Not set (and the comment recording them also failed):',
      ...unwritten.map((field) => `• ${field.label} — ${field.reason}`)
    );
  }

  return lines.join('\n');
}

export async function registerWriteTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // jira_create_issue
  server.registerTool(
    'jira_create_issue',
    {
      title: 'Jira · Act — Create a Jira issue',
      description:
        'Create a new Jira issue in a project, including story points, an original estimate ' +
        "and any custom field — field names are resolved against this site's own schema. A " +
        'field the project will not accept on creation is dropped and recorded as a comment ' +
        'rather than failing the whole issue. If you have not already confirmed this project ' +
        'is a plain software/business project (not a service desk), call jsm_list_service_desks ' +
        'first and check the project key against it — a service desk project has customer-facing ' +
        'request types and SLAs that this tool bypasses entirely; prefer jsm_create_request for those.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
        issueType: z.string().describe('Issue type: Task, Bug, Story, Subtask, Epic, etc.'),
        summary: z.string().describe('Issue title (max 255 characters)'),
        description: z.string().describe('Issue description (markdown format)').optional(),
        priority: z.string().describe('Priority: Highest, High, Medium, Low, Lowest').optional(),
        assignee: z.string().describe('Email address or account ID to assign to').optional(),
        labels: z.array(z.string()).describe('Labels to apply').optional(),
        ...extraFieldSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_create_issue invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey, issueType, summary, description, priority, assignee, labels } = args;

        if (!projectKey || !issueType || !summary) {
          return {
            content: [
              { type: 'text' as const, text: 'projectKey, issueType, and summary are required' },
            ],
            isError: true,
          };
        }

        const projectKeyStr = isString(projectKey) ? projectKey : String(projectKey);
        const issueTypeStr = isString(issueType) ? issueType : String(issueType);
        const summaryStr = isString(summary) ? summary : String(summary);

        const extra = await collectExtraFields(context, args, {
          projectKey: projectKeyStr,
          issueType: issueTypeStr,
        });

        // The issue's identity is what cannot be given up. Everything else,
        // including the built-in optional fields, is droppable if the project
        // refuses it — a create that fails because priority is off the screen
        // has lost the whole issue for nothing.
        const plan: FieldWritePlan = {
          required: {
            project: { key: projectKeyStr },
            issuetype: { name: issueTypeStr },
            summary: summaryStr.substring(0, 255),
          },
          optional: { ...extra.fields },
          labels: { ...extra.labels },
          hints: { ...extra.hints },
        };

        if (description && isString(description)) {
          plan.optional.description = markdownToAdf(description);
          plan.labels.description = 'Description';
        }
        if (priority && isString(priority)) {
          plan.optional.priority = { name: priority };
          plan.labels.priority = `Priority → ${priority}`;
        }
        if (assignee && isString(assignee)) {
          const resolved = await resolveAssigneeId(context, assignee);
          if (resolved.ok) {
            plan.optional.assignee = { id: resolved.id };
            plan.labels.assignee = `Assignee → ${assignee}`;
          } else {
            extra.unwritten.push({ label: `Assignee → ${assignee}`, reason: resolved.reason });
          }
        }
        if (labels && isArray(labels)) {
          plan.optional.labels = labels;
          plan.labels.labels = `Labels → ${labels.join(', ')}`;
        }

        const outcome = await writeWithFieldFallback(plan, async (fields) => {
          const response = await jiraFetch(
            `${context.apiBaseUrl}/rest/api/3/issue`,
            context.accessToken,
            { method: 'POST', body: JSON.stringify({ fields }) }
          );
          return response.json();
        });

        // `sent` is always true here: the mandatory fields are never droppable,
        // so the loop cannot empty the payload out.
        if (!isRecord(outcome.result)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid response from API' }],
            isError: true,
          };
        }
        const resultKey = isString(outcome.result.key)
          ? outcome.result.key
          : String(outcome.result.key);

        const unwritten = [...extra.unwritten, ...outcome.dropped];
        const commented =
          unwritten.length > 0 ? await recordUnwritten(context, resultKey, unwritten) : false;

        const applied = Object.keys(plan.labels)
          .filter((id) => !outcome.dropped.some((field) => plan.labels[id] === field.label))
          .map((id) => plan.labels[id] ?? id);

        const text =
          `Created issue ${resultKey}` +
          describeOutcome(applied, unwritten, commented) +
          `\n\n[Open in Jira](${issueUrl(context.siteUrl, resultKey)})`;
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

  // jira_update_issue
  server.registerTool(
    'jira_update_issue',
    {
      title: 'Jira · Act — Update a Jira issue',
      description:
        'Update an existing Jira issue. Story points, the original estimate, and any custom ' +
        "field can be set: field names are resolved against this site's own schema, so no " +
        'customfield id needs to be known in advance. A field this project will not accept is ' +
        'dropped and recorded as a comment rather than failing the whole update.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        summary: z.string().describe('New title (optional)').optional(),
        description: z.string().describe('New description in markdown (optional)').optional(),
        priority: z.string().describe('New priority (optional)').optional(),
        assignee: z.string().describe('New assignee email or account ID (optional)').optional(),
        labels: z.array(z.string()).describe('New labels (optional, replaces existing)').optional(),
        ...extraFieldSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_update_issue invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, summary, description, priority, assignee, labels } = args;

        if (!isString(issueKey)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        // An update knows its issue, so allowed values come from editmeta —
        // the answer for this exact issue, no issue type needed.
        const extra = await collectExtraFields(context, args, { issueKey });

        // Nothing is mandatory on an update: every field is droppable, so a
        // refused custom field costs that field rather than the summary next to it.
        const plan: FieldWritePlan = {
          required: {},
          optional: { ...extra.fields },
          labels: { ...extra.labels },
          hints: { ...extra.hints },
        };

        if (summary && isString(summary)) {
          plan.optional.summary = summary.substring(0, 255);
          plan.labels.summary = `Summary → ${summary.substring(0, 60)}`;
        }
        if (description && isString(description)) {
          plan.optional.description = markdownToAdf(description);
          plan.labels.description = 'Description';
        }
        if (priority && isString(priority)) {
          plan.optional.priority = { name: priority };
          plan.labels.priority = `Priority → ${priority}`;
        }
        if (assignee && isString(assignee)) {
          const resolved = await resolveAssigneeId(context, assignee);
          if (resolved.ok) {
            plan.optional.assignee = { id: resolved.id };
            plan.labels.assignee = `Assignee → ${assignee}`;
          } else {
            extra.unwritten.push({ label: `Assignee → ${assignee}`, reason: resolved.reason });
          }
        }
        if (labels && isArray(labels)) {
          plan.optional.labels = labels;
          plan.labels.labels = `Labels → ${labels.join(', ')}`;
        }

        // Everything the caller asked for turned out to be unwritable, so there
        // is no request to make. The comment is then the whole point of the call.
        if (Object.keys(plan.optional).length === 0) {
          if (extra.unwritten.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `Nothing to update on ${issueKey}` }],
              isError: true,
            };
          }

          const noted = await recordUnwritten(context, issueKey, extra.unwritten);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Nothing could be written to ${issueKey}` +
                  describeOutcome([], extra.unwritten, noted) +
                  `\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`,
              },
            ],
            isError: true,
          };
        }

        const outcome = await writeWithFieldFallback(plan, async (fields) => {
          await jiraFetch(
            `${context.apiBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
            context.accessToken,
            { method: 'PUT', body: JSON.stringify({ fields }) }
          );
        });

        const unwritten = [...extra.unwritten, ...outcome.dropped];
        const commented =
          unwritten.length > 0 ? await recordUnwritten(context, issueKey, unwritten) : false;

        const applied = Object.keys(plan.labels)
          .filter((id) => !outcome.dropped.some((field) => plan.labels[id] === field.label))
          .map((id) => plan.labels[id] ?? id);

        const headline = outcome.sent
          ? `Updated ${issueKey}`
          : `Nothing could be written to ${issueKey}`;
        const text =
          headline +
          describeOutcome(applied, unwritten, commented) +
          `\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
        return {
          content: [{ type: 'text' as const, text }],
          ...(outcome.sent ? {} : { isError: true }),
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

  // jira_add_comment
  server.registerTool(
    'jira_add_comment',
    {
      title: 'Jira · Act — Comment on a Jira issue',
      description: 'Add a comment to a Jira issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        comment: z.string().describe('Comment text (markdown format)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_add_comment invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, comment } = args;

        if (!isString(issueKey) || !isString(comment)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and comment are required' }],
            isError: true,
          };
        }

        const commentStr = comment;
        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/comment`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              body: markdownToAdf(commentStr),
            }),
          }
        );

        const text = `Comment added to ${issueKey}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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

  // jira_transition_issue
  server.registerTool(
    'jira_transition_issue',
    {
      title: 'Jira · Act — Move a Jira issue through its workflow',
      description: 'Transition an issue to a different status.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        transitionName: z
          .string()
          .describe('Transition name, e.g. "Start Progress", "Resolve Issue"'),
        comment: z.string().describe('Optional comment to add during transition').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_transition_issue invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, transitionName, comment } = args;

        if (!isString(issueKey) || !isString(transitionName)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and transitionName are required' }],
            isError: true,
          };
        }

        // First, get available transitions
        const transResponse = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/transitions`,
          context.accessToken
        );
        const transData = await transResponse.json();
        if (!isRecord(transData)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid response from transitions API' }],
            isError: true,
          };
        }

        // Find the matching transition
        const transitionNameStr = transitionName;
        const transitions = isArray(transData.transitions) ? transData.transitions : [];
        const transition = transitions.find((t: unknown) => {
          if (!isRecord(t)) {
            return false;
          }
          return isString(t.name) && t.name.toLowerCase() === transitionNameStr.toLowerCase();
        });

        if (!transition) {
          const availableNames = transitions
            .map((t: unknown) => (isRecord(t) && isString(t.name) ? t.name : null))
            .filter((name): name is string => name !== null)
            .join(', ');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Transition "${transitionNameStr}" not found. Available: ${availableNames || 'none'}`,
              },
            ],
            isError: true,
          };
        }

        // Execute the transition
        if (!isRecord(transition)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid transition object' }],
            isError: true,
          };
        }
        const body: Record<string, unknown> = {
          transition: { id: transition.id },
        };

        if (comment && isString(comment)) {
          body.update = {
            comment: [
              {
                add: {
                  body: markdownToAdf(comment),
                },
              },
            ],
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/transitions`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const text = `Transitioned ${issueKey} to ${transitionName}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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

  // jira_log_work
  server.registerTool(
    'jira_log_work',
    {
      title: 'Jira · Act — Log work against a Jira issue',
      description: 'Log time spent on a Jira issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        timeSpent: z.string().describe('Time spent in Jira format: 1d, 2h, 30m, 1w'),
        comment: z.string().describe('Optional comment (what was done)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_log_work invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, timeSpent, comment } = args;

        if (!isString(issueKey) || !isString(timeSpent)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and timeSpent are required' }],
            isError: true,
          };
        }

        const timeSpentStr = timeSpent;
        const body: Record<string, unknown> = {
          timeSpent: timeSpentStr,
        };

        if (comment && isString(comment)) {
          body.comment = markdownToAdf(comment);
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/worklog`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const text = `Logged ${timeSpent} on ${issueKey}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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

  // jira_delete_issue
  server.registerTool(
    'jira_delete_issue',
    {
      title: 'Jira · Act — Delete a Jira issue',
      description:
        'Permanently delete a Jira issue. If the issue has subtasks, set deleteSubtasks to true to delete them along with the issue. This action cannot be undone.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        deleteSubtasks: z
          .boolean()
          .describe(
            'If true, delete the issue and all its subtasks. If false, the issue cannot be deleted if it has subtasks.'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_delete_issue invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, deleteSubtasks } = args;

        if (!isString(issueKey)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        let url = `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}`;
        if (deleteSubtasks === true) {
          url += '?deleteSubtasks=true';
        }

        await jiraFetch(url, context.accessToken, {
          method: 'DELETE',
        });

        const text = `Issue ${issueKey} has been deleted.`;
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

  // jira_delete_comment
  server.registerTool(
    'jira_delete_comment',
    {
      title: 'Jira · Act — Delete a comment from a Jira issue',
      description: 'Permanently delete a comment from a Jira issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        commentId: z.string().describe('Comment ID to delete'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_delete_comment invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, commentId } = args;

        if (!isString(issueKey) || !isString(commentId)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and commentId are required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/comment/${commentId}`,
          context.accessToken,
          {
            method: 'DELETE',
          }
        );

        const text = `Comment ${commentId} has been deleted from ${issueKey}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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
}
