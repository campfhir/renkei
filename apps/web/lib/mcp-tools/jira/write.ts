/**
 * Write tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { issueUrl, getCachedDisplayName } from '../common';
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
import { APP_ONLY_META, ISSUE_PREVIEW_URI, confirmGuard, previewToolMeta } from '../widgets';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

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
  auth: JiraAuth,
  value: string
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!value.includes('@') && /^[0-9a-zA-Z:-]{16,128}$/.test(value)) {
    return { ok: true, id: value };
  }
  const response = await auth.fetch(
    granularJiraScopes('jira_search_users', true),
    `/rest/api/3/user/search?query=${encodeURIComponent(value)}`
  );
  const users: unknown = response.ok ? await response.json().catch(() => null) : null;
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
  auth: JiraAuth,
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
    const lookup = findStoryPointsField(await loadFieldSchema(context, auth));
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
    const updates = await buildFieldUpdates(context, auth, args.fields, options);
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
  auth: JiraAuth,
  issueKey: string,
  unwritten: readonly UnwrittenField[]
): Promise<boolean> {
  try {
    const response = await auth.fetch(
      granularJiraScopes('jira_add_comment', false),
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        method: 'POST',
        body: JSON.stringify({ body: markdownToAdf(unwrittenFieldsComment(unwritten)) }),
      }
    );
    if (!response.ok) {
      throw new Error(await describeJiraAuthFailure(response));
    }
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
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_create_issue — schema and handler shared with the card-invoked
  // jira_create_issue_confirm below, so the confirm path IS the create path.
  const createIssueSchema = z.object({
    projectKey: z.string().describe('Project key, e.g. SCRUM'),
    issueType: z.string().describe('Issue type: Task, Bug, Story, Subtask, Epic, etc.'),
    summary: z.string().describe('Issue title (max 255 characters)'),
    description: z.string().describe('Issue description (markdown format)').optional(),
    priority: z.string().describe('Priority: Highest, High, Medium, Low, Lowest').optional(),
    assignee: z.string().describe('Email address or account ID to assign to').optional(),
    labels: z.array(z.string()).describe('Labels to apply').optional(),
    ...extraFieldSchema,
  });
  const createIssueHandler = async (args: Record<string, unknown>) => {
    const displayName = getCachedDisplayName(context.accountId);
    logger.debug('jira_create_issue invoked', {
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

      const extra = await collectExtraFields(context, auth, args, {
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
        const resolved = await resolveAssigneeId(auth, assignee);
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
        const response = await auth.fetch(
          granularJiraScopes('jira_create_issue', false),
          '/rest/api/3/issue',
          { method: 'POST', body: JSON.stringify({ fields }) }
        );
        if (!response.ok) {
          throw new Error(await describeJiraAuthFailure(response));
        }
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
        unwritten.length > 0 ? await recordUnwritten(context, auth, resultKey, unwritten) : false;

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
  };
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
      inputSchema: createIssueSchema,
    },
    createIssueHandler
  );

  // jira_update_issue — same sharing as create above.
  const updateIssueSchema = z.object({
    issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
    summary: z.string().describe('New title (optional)').optional(),
    description: z.string().describe('New description in markdown (optional)').optional(),
    priority: z.string().describe('New priority (optional)').optional(),
    assignee: z.string().describe('New assignee email or account ID (optional)').optional(),
    labels: z.array(z.string()).describe('New labels (optional, replaces existing)').optional(),
    ...extraFieldSchema,
  });
  const updateIssueHandler = async (args: Record<string, unknown>) => {
    const displayName = getCachedDisplayName(context.accountId);
    logger.debug('jira_update_issue invoked', {
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
      const extra = await collectExtraFields(context, auth, args, { issueKey });

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
        const resolved = await resolveAssigneeId(auth, assignee);
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

        const noted = await recordUnwritten(context, auth, issueKey, extra.unwritten);
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
        const response = await auth.fetch(
          granularJiraScopes('jira_update_issue', false),
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
          { method: 'PUT', body: JSON.stringify({ fields }) }
        );
        if (!response.ok) {
          throw new Error(await describeJiraAuthFailure(response));
        }
      });

      const unwritten = [...extra.unwritten, ...outcome.dropped];
      const commented =
        unwritten.length > 0 ? await recordUnwritten(context, auth, issueKey, unwritten) : false;

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
  };
  server.registerTool(
    'jira_update_issue',
    {
      title: 'Jira · Act — Update a Jira issue',
      description:
        'Update ONE existing Jira issue (same change across many: use jira_bulk_update_issues). ' +
        'Story points, the original estimate, and any custom ' +
        "field can be set: field names are resolved against this site's own schema, so no " +
        'customfield id needs to be known in advance. A field this project will not accept is ' +
        'dropped and recorded as a comment rather than failing the whole update.',
      annotations: { readOnlyHint: false },
      inputSchema: updateIssueSchema,
    },
    updateIssueHandler
  );

  // ——— Interactive previews (MCP Apps) ————————————————————————————————
  // Like the WebEx/Zoom previews and unlike Outlook's, nothing is created at
  // preview time — Jira has no draft concept worth simulating when the
  // create/update handlers already degrade gracefully field by field. The
  // card holds the request; its confirm button runs the SAME handler the
  // direct tools run, via the app-only *_confirm twins above each pair.

  /** Display rows for the card out of the create/update arguments. */
  const argFieldRows = (args: Record<string, unknown>): { label: string; value: string }[] => {
    const rows: { label: string; value: string }[] = [];
    if (isString(args.priority) && args.priority) {
      rows.push({ label: 'Priority', value: args.priority });
    }
    if (isString(args.assignee) && args.assignee) {
      rows.push({ label: 'Assignee', value: args.assignee });
    }
    if (isArray(args.labels) && args.labels.length > 0) {
      rows.push({ label: 'Labels', value: args.labels.map(String).join(', ') });
    }
    if (isNumber(args.storyPoints)) {
      rows.push({ label: 'Story points', value: String(args.storyPoints) });
    }
    if (isString(args.originalEstimate) && args.originalEstimate) {
      rows.push({ label: 'Original estimate', value: args.originalEstimate });
    }
    if (isRecord(args.fields)) {
      for (const [name, value] of Object.entries(args.fields)) {
        rows.push({
          label: name,
          value: typeof value === 'string' ? value : JSON.stringify(value),
        });
      }
    }
    return rows;
  };

  const previewGuidance = (what: string) =>
    `${what} is awaiting the user's decision on the preview card. Do not write it another ` +
    `way and do not repeat its contents in your reply; the user confirms or cancels from ` +
    `the card. If no card appeared in this client, ask the user how to proceed.`;

  server.registerTool(
    'jira_create_issue_preview',
    {
      title: 'Jira · Act — Preview an issue before creating it',
      description:
        'Show the user an interactive preview card of a new Jira issue to create or cancel. ' +
        'Prefer this over jira_create_issue whenever the user should review first — the card ' +
        'does the creating. Same fields and field resolution as jira_create_issue.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: createIssueSchema,
    },
    async (args: Record<string, unknown>) => {
      const { projectKey, issueType, summary } = args;
      if (!projectKey || !issueType || !summary) {
        return errText('projectKey, issueType, and summary are required');
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: previewGuidance(`The new ${String(issueType)} in ${String(projectKey)}`),
          },
        ],
        structuredContent: {
          kind: 'issue',
          title: 'Create Jira issue',
          subtitle: `${String(projectKey)} · ${String(issueType)}`,
          confirmTool: 'jira_create_issue_confirm',
          confirmLabel: 'Create',
          confirmArgs: args,
          editable: { summaryKey: 'summary', descriptionKey: 'description' },
          fields: argFieldRows(args),
        },
      };
    }
  );

  server.registerTool(
    'jira_create_issue_confirm',
    {
      title: 'Jira · Act — Create a previewed issue (card only)',
      description:
        'Create a Jira issue the user approved on a preview card.' +
        confirmGuard('jira_create_issue_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: createIssueSchema,
    },
    createIssueHandler
  );

  server.registerTool(
    'jira_update_issue_preview',
    {
      title: 'Jira · Act — Preview an issue update before applying it',
      description:
        'Show the user an interactive preview card of changes to a Jira issue, with current ' +
        'values alongside for comparison, to apply or cancel. Prefer this over ' +
        'jira_update_issue whenever the user should review first — the card does the updating.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: updateIssueSchema,
    },
    async (args: Record<string, unknown>) => {
      const { issueKey } = args;
      if (!isString(issueKey) || !issueKey) return errText('issueKey is required');
      const changed = ['summary', 'description', 'priority', 'assignee', 'labels'].some(
        (key) => args[key] !== undefined
      );
      if (!changed && !isRecord(args.fields) && !isNumber(args.storyPoints)) {
        return errText(`Nothing to update on ${issueKey}`);
      }

      // Best-effort current values, so the card can show what changes rather
      // than only the end state. A failed read costs the "was:" lines, not
      // the preview.
      let current: Record<string, unknown> = {};
      try {
        const response = await auth.fetch(
          granularJiraScopes('jira_get_issue', true),
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,priority,assignee,labels`
        );
        const body: unknown = response.ok ? await response.json().catch(() => null) : null;
        if (isRecord(body) && isRecord(body.fields)) current = body.fields;
      } catch {
        // preview renders without old values
      }
      const priorityOld = isRecord(current.priority) ? current.priority.name : undefined;
      const assigneeOld = isRecord(current.assignee) ? current.assignee.displayName : undefined;
      const labelsOld = isArray(current.labels) ? current.labels.map(String).join(', ') : '';

      const fields = argFieldRows(args).map((row) => {
        if (row.label === 'Priority' && isString(priorityOld)) {
          return { ...row, oldValue: priorityOld };
        }
        if (row.label === 'Assignee' && isString(assigneeOld)) {
          return { ...row, oldValue: assigneeOld };
        }
        if (row.label === 'Labels' && labelsOld) return { ...row, oldValue: labelsOld };
        return row;
      });

      return {
        content: [{ type: 'text' as const, text: previewGuidance(`The update to ${issueKey}`) }],
        structuredContent: {
          kind: 'issue',
          title: `Update ${issueKey}`,
          ...(isString(current.summary) ? { subtitle: current.summary } : {}),
          confirmTool: 'jira_update_issue_confirm',
          confirmLabel: 'Update',
          confirmArgs: args,
          editable: {
            ...(isString(args.summary) ? { summaryKey: 'summary' } : {}),
            ...(isString(args.description) ? { descriptionKey: 'description' } : {}),
          },
          fields,
        },
      };
    }
  );

  server.registerTool(
    'jira_update_issue_confirm',
    {
      title: 'Jira · Act — Apply a previewed update (card only)',
      description:
        'Apply an issue update the user approved on a preview card.' +
        confirmGuard('jira_update_issue_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: updateIssueSchema,
    },
    updateIssueHandler
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
      logger.debug('jira_add_comment invoked', {
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
        const response = await auth.fetch(
          granularJiraScopes('jira_add_comment', false),
          `/rest/api/3/issue/${issueKey}/comment`,
          {
            method: 'POST',
            body: JSON.stringify({
              body: markdownToAdf(commentStr),
            }),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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
      description:
        'Transition ONE issue to a different status. For many issues, use ' +
        'jira_bulk_transition_issues instead — one call, not one per issue.',
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
      logger.debug('jira_transition_issue invoked', {
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
        const transResponse = await auth.fetch(
          granularJiraScopes('jira_transition_issue', true),
          `/rest/api/3/issue/${issueKey}/transitions`
        );
        if (!transResponse.ok) return errText(await describeJiraAuthFailure(transResponse));
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

        const execResponse = await auth.fetch(
          granularJiraScopes('jira_transition_issue', false),
          `/rest/api/3/issue/${issueKey}/transitions`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
        if (!execResponse.ok) return errText(await describeJiraAuthFailure(execResponse));

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
      logger.debug('jira_log_work invoked', {
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

        const response = await auth.fetch(
          granularJiraScopes('jira_log_work', false),
          `/rest/api/3/issue/${issueKey}/worklog`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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

  // jira_delete_issue — schema and handler shared with the card-invoked
  // jira_delete_issue_confirm below, so the confirm path IS the delete path.
  const deleteIssueSchema = z.object({
    issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
    deleteSubtasks: z
      .boolean()
      .describe(
        'If true, delete the issue and all its subtasks. If false, the issue cannot be deleted if it has subtasks.'
      )
      .optional(),
  });
  const deleteIssueHandler = async (args: Record<string, unknown>) => {
    const displayName = getCachedDisplayName(context.accountId);
    logger.debug('jira_delete_issue invoked', {
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

      let path = `/rest/api/3/issue/${issueKey}`;
      if (deleteSubtasks === true) {
        path += '?deleteSubtasks=true';
      }

      const response = await auth.fetch(granularJiraScopes('jira_delete_issue', false), path, {
        method: 'DELETE',
      });
      if (!response.ok) return errText(await describeJiraAuthFailure(response));

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
  };
  server.registerTool(
    'jira_delete_issue',
    {
      title: 'Jira · Act — Delete a Jira issue',
      description:
        'Permanently delete a Jira issue. If the issue has subtasks, set deleteSubtasks to true ' +
        'to delete them along with the issue. This action cannot be undone — prefer ' +
        'jira_delete_issue_preview whenever the user should confirm first.',
      annotations: { readOnlyHint: false },
      inputSchema: deleteIssueSchema,
    },
    deleteIssueHandler
  );

  server.registerTool(
    'jira_delete_issue_preview',
    {
      title: 'Jira · Act — Preview an issue deletion before it happens',
      description:
        'Show the user an interactive confirmation card before permanently deleting a Jira ' +
        'issue — the card does the deleting. Prefer this over jira_delete_issue whenever a ' +
        'person is present to confirm: deletion cannot be undone.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: deleteIssueSchema,
    },
    async (args: Record<string, unknown>) => {
      const { issueKey } = args;
      if (!isString(issueKey) || !issueKey) return errText('issueKey is required');

      // Best-effort context so the card names what dies: summary, type, and
      // the subtask count that decides whether deleteSubtasks matters. A
      // failed read costs the labels, never the preview.
      let summary = '';
      let issueType = '';
      let subtaskCount = 0;
      try {
        const response = await auth.fetch(
          granularJiraScopes('jira_get_issue', true),
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,issuetype,subtasks`
        );
        const body: unknown = response.ok ? await response.json().catch(() => null) : null;
        if (isRecord(body) && isRecord(body.fields)) {
          if (isString(body.fields.summary)) summary = body.fields.summary;
          if (isRecord(body.fields.issuetype) && isString(body.fields.issuetype.name)) {
            issueType = body.fields.issuetype.name;
          }
          if (isArray(body.fields.subtasks)) subtaskCount = body.fields.subtasks.length;
        }
      } catch {
        // preview renders with the key alone
      }

      return {
        content: [{ type: 'text' as const, text: previewGuidance(`The deletion of ${issueKey}`) }],
        structuredContent: {
          kind: 'issue',
          title: `Delete ${issueKey} permanently`,
          ...(summary ? { subtitle: summary } : {}),
          confirmTool: 'jira_delete_issue_confirm',
          confirmLabel: 'Delete permanently',
          confirmArgs: args,
          fields: [
            { label: 'Issue', value: issueKey },
            ...(issueType ? [{ label: 'Type', value: issueType }] : []),
            ...(subtaskCount > 0
              ? [
                  {
                    label: 'Subtasks',
                    value:
                      args.deleteSubtasks === true
                        ? `${subtaskCount} — will be deleted too`
                        : `${subtaskCount} — deletion will be REFUSED unless deleteSubtasks is set`,
                  },
                ]
              : []),
            { label: 'Undo', value: 'None — deletion is permanent' },
          ],
        },
      };
    }
  );

  server.registerTool(
    'jira_delete_issue_confirm',
    {
      title: 'Jira · Act — Delete a previewed issue (card only)',
      description:
        'Permanently delete an issue the user approved on a preview card.' +
        confirmGuard('jira_delete_issue_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: deleteIssueSchema,
    },
    deleteIssueHandler
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
      logger.debug('jira_delete_comment invoked', {
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

        const response = await auth.fetch(
          granularJiraScopes('jira_delete_comment', false),
          `/rest/api/3/issue/${issueKey}/comment/${commentId}`,
          {
            method: 'DELETE',
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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
