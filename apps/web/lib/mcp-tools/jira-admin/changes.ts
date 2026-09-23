/**
 * Proposing Jira admin changes, and following up on them.
 *
 * `jira_admin_propose_option_changes` is an Act tool that changes nothing
 * in Jira: it reads the field as it is, turns the request into exact
 * operations, and stores them as a change request (lib/jira-admin). The
 * person applies it from the review page it links to, signed in to Renkei —
 * the one path that can apply anything, because no MCP host can prove a
 * click was a person's rather than the model's
 * (docs/project-management-design.md, "The confirm rule").
 *
 * It is still an Act tool, not a Read: org read-only mode hides it, the
 * way it refuses the apply, and a proposal is the first half of a write.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import type { JiraAdminAccess } from './client';
import { errText, jiraAdminGet, rec, records, str, textResult } from './client';
import { fieldTypeLabel, findCustomField, optionTypeOf } from './fields';
import {
  CHANGE_REQUEST_TTL_HOURS,
  cancelChangeRequest,
  createChangeRequest,
  getChangeRequest,
  listChangeRequests,
  stateOf,
  type ChangeRequest,
  type ChangeRequestState,
} from '@/lib/jira-admin/change-requests';
import {
  FIELD_OPTIONS_KIND,
  levelOf,
  planOptionOperations,
  readContextOptions,
  titleFor,
  type FieldOptionsPayload,
  type OptionChangeInput,
} from '@/lib/jira-admin/field-options';
import { describeChange, operationLines } from '@/lib/jira-admin/describe';
import { reviewPrefix } from './review-link';

const optionList = (what: string) =>
  z.array(z.string().min(1).max(255)).max(100).describe(what).optional();

type ContextPick =
  { ok: true; context: Record<string, unknown>; note?: string } | { ok: false; reason: string };

/**
 * Which of the field's contexts the change lands in: the one named, the
 * one covering the named space, or the only one there is. Never a guess
 * between several — a wrong context is a change in the wrong spaces.
 */
async function pickContext(
  context: MCPToolContext,
  access: JiraAdminAccess,
  fieldId: string,
  contexts: Record<string, unknown>[],
  wanted: { context: string; space: string }
): Promise<ContextPick> {
  const label = (ctx: Record<string, unknown>) =>
    `${str(ctx.name) || '(unnamed)'} (id ${str(ctx.id)}${ctx.isGlobalContext === true ? ', global' : ''})`;

  if (wanted.context) {
    const byId = contexts.find((ctx) => str(ctx.id) === wanted.context);
    if (byId) return { ok: true, context: byId };
    const byName = contexts.filter(
      (ctx) => str(ctx.name).trim().toLowerCase() === wanted.context.toLowerCase()
    );
    if (byName.length === 1) return { ok: true, context: byName[0] };
    return {
      ok: false,
      reason:
        (byName.length > 1
          ? `${byName.length} contexts are named "${wanted.context}" — pass the id of one: `
          : `This field has no context "${wanted.context}". Its contexts: `) +
        (byName.length > 1 ? byName : contexts).map(label).join(', '),
    };
  }

  if (wanted.space) {
    const project = await jiraAdminGet(
      context,
      access,
      `/rest/api/3/project/${encodeURIComponent(wanted.space)}`
    );
    if (!project.ok) return { ok: false, reason: `Space ${wanted.space}: ${project.error}` };
    const projectId = str(rec(project.body).id);
    const spaceKey = str(rec(project.body).key) || wanted.space;
    const mappings = await jiraAdminGet(
      context,
      access,
      `/rest/api/3/field/${encodeURIComponent(fieldId)}/context/projectmapping?maxResults=50`
    );
    if (!mappings.ok) return { ok: false, reason: mappings.error };
    const mapped = records(mappings.body).find(
      (mapping) => mapping.isGlobalContext !== true && str(mapping.projectId) === projectId
    );
    const own = mapped && contexts.find((ctx) => str(ctx.id) === str(mapped.contextId));
    if (own) return { ok: true, context: own };
    const global = contexts.find((ctx) => ctx.isGlobalContext === true);
    if (global) {
      return {
        ok: true,
        context: global,
        note:
          `${spaceKey} has no context of its own for this field, so this changes the global ` +
          'context — every space without its own context will see it.',
      };
    }
    return { ok: false, reason: `No context of this field covers ${spaceKey}.` };
  }

  if (contexts.length === 1) return { ok: true, context: contexts[0] };
  return {
    ok: false,
    reason:
      contexts.length === 0
        ? 'This field has no contexts, so it has no options to change.'
        : `This field has ${contexts.length} contexts — pass context (its id or name) or space: ` +
          contexts.map(label).join(', '),
  };
}

/** Keys of the spaces a non-global context covers, best-effort, for the review page. */
async function spacesOf(
  context: MCPToolContext,
  access: JiraAdminAccess,
  fieldId: string,
  contextId: string
): Promise<string[]> {
  const mappings = await jiraAdminGet(
    context,
    access,
    `/rest/api/3/field/${encodeURIComponent(fieldId)}/context/projectmapping?maxResults=50`
  );
  if (!mappings.ok) return [];
  const ids = records(mappings.body)
    .filter((mapping) => str(mapping.contextId) === contextId && str(mapping.projectId))
    .map((mapping) => str(mapping.projectId))
    .slice(0, 50);
  if (ids.length === 0) return [];
  const projects = await jiraAdminGet(
    context,
    access,
    `/rest/api/3/project/search?maxResults=50&${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`
  );
  const keys = new Map(
    (projects.ok ? records(projects.body) : []).map((project) => [
      str(project.id),
      str(project.key),
    ])
  );
  return ids.map((id) => keys.get(id) || `id ${id}`);
}

const STATE_WORDS: Record<ChangeRequestState, string> = {
  pending: 'waiting for review',
  applying: 'being applied',
  applied: 'applied',
  partial: 'partly applied',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
  interrupted: 'interrupted while applying — check Jira',
};

function hoursLeft(change: ChangeRequest): string {
  const hours = Math.max(0, (change.expiresAt.getTime() - Date.now()) / 3_600_000);
  return hours >= 1 ? `${Math.floor(hours)}h` : `${Math.max(1, Math.round(hours * 60))}m`;
}

function changeLine(change: ChangeRequest, link: string): string {
  const state = stateOf(change);
  const when =
    state === 'pending'
      ? `, expires in ${hoursLeft(change)}`
      : change.appliedAt
        ? ` ${change.appliedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
        : '';
  const tally = change.results
    ? ` — ${change.results.filter((result) => result.outcome === 'done').length} of ${change.results.length} done`
    : '';
  return `• ${change.title} — ${STATE_WORDS[state]}${when}${tally}\n  ${link}`;
}

export async function registerChangeTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_propose_option_changes',
    {
      title: 'Jira Admin · Act — Propose changes to a field’s options',
      description:
        'Propose adding, renaming, disabling, enabling or reordering the options of a select ' +
        'list, radio button, checkbox or cascading custom field, in one of its contexts. ' +
        'Nothing changes in Jira: this saves a change request, and the user applies it ' +
        `themselves from the Renkei review page linked in the result (it expires in ` +
        `${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link. Read the field first ` +
        '(jira_admin_get_field): options belong to a context, and a global context reaches ' +
        'every space without one of its own. Options are named by their current value. ' +
        'Nothing is ever deleted — disabling keeps an option on the issues that have it. To ' +
        'revise a pending proposal, pass replaces with its id rather than proposing twice.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        field: z
          .string()
          .min(1)
          .describe('The custom field — its id (customfield_10321) or its exact name'),
        context: z
          .string()
          .describe(
            'The context to change — its id or exact name. Needed when the field has more ' +
              'than one, unless space is given.'
          )
          .optional(),
        space: z
          .string()
          .describe(
            'A space key (OPS): change the context that covers this space — its own, or the ' +
              'global one when it has none (the result says which).'
          )
          .optional(),
        parent: z
          .string()
          .describe(
            'Cascading selects only: the parent option whose child options these changes ' +
              'apply to. Leave out to change the top-level options.'
          )
          .optional(),
        add: optionList('New options, by value'),
        rename: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1).max(255) }))
          .max(50)
          .describe('Options to rename: from its current value, to the new one')
          .optional(),
        disable: optionList(
          'Options to disable, by current value: they stay on existing issues but can no ' +
            'longer be picked'
        ),
        enable: optionList('Disabled options to enable again, by current value'),
        move: z
          .object({
            options: z.array(z.string().min(1)).min(1).max(1000),
            position: z.enum(['first', 'last']).optional(),
          })
          .describe(
            'Move these options, in this order, to the top (first, the default) or the bottom ' +
              '(last). May name options this same request adds or renames (by their new value).'
          )
          .optional(),
        sortAlphabetically: z
          .boolean()
          .describe('Sort all the options A–Z (after any adds and renames)')
          .optional(),
        reason: z
          .string()
          .max(1000)
          .describe('Why — shown to the user on the review page')
          .optional(),
        replaces: z
          .string()
          .describe(
            'The id of a pending change request of this user’s that this one supersedes; it is ' +
              'cancelled once this one is saved'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const reference = typeof args.field === 'string' ? args.field : '';
      if (!reference.trim()) return errText('field is required');
      const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
      const strings = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];
      const move = rec(args.move);
      const input: OptionChangeInput = {
        add: strings(args.add),
        rename: Array.isArray(args.rename)
          ? args.rename.map((item) => ({ from: text(rec(item).from), to: text(rec(item).to) }))
          : [],
        disable: strings(args.disable),
        enable: strings(args.enable),
        move: Array.isArray(move.options)
          ? {
              options: strings(move.options),
              position: move.position === 'last' ? 'last' : 'first',
            }
          : undefined,
        sortAlphabetically: args.sortAlphabetically === true,
      };

      const found = await findCustomField(context, access, reference);
      if (!found.ok) return errText(found.reason);
      const field = found.field;
      const fieldId = str(field.id);
      const optionType = optionTypeOf(field);
      if (!optionType) {
        return errText(
          `${str(field.name)} is a ${fieldTypeLabel(field)} field, which has no options to change.`
        );
      }
      if (field.isLocked === true) {
        return errText(
          `${str(field.name)} is locked — managed by Jira or an app — so its options cannot be changed.`
        );
      }
      const parentValue = text(args.parent);
      if (parentValue && optionType !== 'cascadingselect') {
        return errText('parent applies to cascading select fields only.');
      }

      const contextsResult = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/field/${encodeURIComponent(fieldId)}/context?maxResults=50`
      );
      if (!contextsResult.ok) return errText(contextsResult.error);
      const picked = await pickContext(context, access, fieldId, records(contextsResult.body), {
        context: text(args.context),
        space: text(args.space).toUpperCase(),
      });
      if (!picked.ok) return errText(picked.reason);
      const contextId = str(picked.context.id);
      const global = picked.context.isGlobalContext === true;

      const live = await readContextOptions(context, access, fieldId, contextId);
      if (!live.ok) return errText(live.error);

      let parent: { id: string; value: string } | null = null;
      if (parentValue) {
        const match = levelOf(live.options, null).find(
          (option) => option.value.trim().toLowerCase() === parentValue.toLowerCase()
        );
        if (!match)
          return errText(`There is no top-level option "${parentValue}" to change under.`);
        parent = { id: match.id, value: match.value };
      }

      const plan = planOptionOperations(input, levelOf(live.options, parent?.id ?? null));
      if (!plan.ok) return errText(plan.reason);

      const payload: FieldOptionsPayload = {
        field: { id: fieldId, name: str(field.name), type: fieldTypeLabel(field) },
        context: {
          id: contextId,
          name: str(picked.context.name),
          global,
          spaces: global ? [] : await spacesOf(context, access, fieldId, contextId),
        },
        parent,
        operations: plan.operations,
      };

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was proposed.');
      const reason = text(args.reason);
      const change = await createChangeRequest(dbResult.val, {
        tenantId: context.tenantId,
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        kind: FIELD_OPTIONS_KIND,
        title: titleFor(payload),
        reason: reason || undefined,
        payload,
      });

      const notes: string[] = [];
      if (picked.note) notes.push(picked.note);
      const replaces = text(args.replaces);
      if (replaces) {
        const cancelled = await cancelChangeRequest(
          dbResult.val,
          context.tenantId,
          context.subject,
          replaces
        );
        notes.push(
          cancelled
            ? `Cancelled the request it replaces (${replaces}).`
            : `Did not cancel ${replaces}: it is not a pending request of this user’s.`
        );
      }

      const link = `${await reviewPrefix(context)}${change.id}`;
      const { operations, reach } = describeChange(change);
      const lines = [
        'Proposed — nothing has changed in Jira yet.',
        '',
        ...operationLines(operations),
        ...(reach ? ['', `Where: ${reach}`] : []),
        ...(notes.length > 0 ? ['', ...notes] : []),
        '',
        `Review and apply: ${link}`,
        `Change request ${change.id}; it expires in ${CHANGE_REQUEST_TTL_HOURS} hours. Only the ` +
          'user can apply it, from that page while signed in to Renkei — share the link.',
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        _meta: actMeta({ url: link }),
      };
    }
  );

  server.registerTool(
    'jira_admin_list_changes',
    {
      title: 'Jira Admin · Read — List proposed admin changes',
      description:
        'The user’s Jira admin change requests, newest first: what each changes, whether it ' +
        'is waiting for review, applied, failed or expired, and its review link. Pass change ' +
        'with an id for one request in full, including what each operation returned when it ' +
        'was applied.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        pending: z
          .boolean()
          .describe('Only requests still waiting for review (default: all recent ones)')
          .optional(),
        change: z.string().describe('One change request’s id, for its full detail').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      const id = typeof args.change === 'string' ? args.change.trim() : '';
      if (id) {
        const change = await getChangeRequest(db, context.tenantId, context.subject, id);
        if (!change) return errText(`No change request ${id} of this user’s.`);
        const { operations, reach } = describeChange(change);
        const state = stateOf(change);
        const lines = [
          change.title,
          `Status: ${STATE_WORDS[state]}` +
            (state === 'pending' ? ` (expires in ${hoursLeft(change)})` : ''),
          ...(reach ? [`Where: ${reach}`] : []),
          ...(change.reason ? [`Why: ${change.reason}`] : []),
          '',
          ...(change.results
            ? change.results.map(
                (result) =>
                  `• ${result.label} — ${result.outcome === 'not_run' ? 'not run' : result.outcome}` +
                  (result.detail ? `: ${result.detail}` : '')
              )
            : operationLines(operations)),
          '',
          `${await reviewPrefix(context)}${change.id}`,
        ];
        return textResult(lines.join('\n'));
      }

      const changes = await listChangeRequests(db, context.tenantId, context.subject, {
        limit: 20,
        pendingOnly: args.pending === true,
      });
      if (changes.length === 0) {
        return textResult(
          args.pending === true
            ? 'No change requests are waiting for review.'
            : 'No Jira admin change requests yet.'
        );
      }
      const prefix = await reviewPrefix(context);
      return textResult(
        changes.map((change) => changeLine(change, `${prefix}${change.id}`)).join('\n')
      );
    }
  );
}
