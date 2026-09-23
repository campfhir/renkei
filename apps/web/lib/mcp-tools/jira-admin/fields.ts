/**
 * Custom fields as an administrator sees them: what exists, what type it
 * is, how widely it is used, and — per context — which spaces and work
 * types it applies to and which options it offers.
 *
 * Contexts are the part people get wrong. A custom field is site-wide, but
 * its options live on a CONTEXT, and a context either covers every space
 * (global) or a named list of them. Adding an option to a global context
 * changes the field in every space that has no context of its own, which
 * is why get_field says so beside every global context it lists.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import type { JiraAdminAccess } from './client';
import { errText, jiraAdminGet, rec, records, str, textResult } from './client';

const FIELD_EXPAND = 'lastUsed,screensCount,contextsCount,isLocked';
/** Contexts described in full; a field with more is summarized. */
const MAX_CONTEXTS = 20;
/** Options listed per context before the rest is counted. */
const MAX_OPTIONS = 100;

/** Friendly names for the custom field types people actually meet. */
const TYPE_LABELS: Record<string, string> = {
  select: 'select list (single choice)',
  multiselect: 'select list (multiple choices)',
  radiobuttons: 'radio buttons',
  multicheckboxes: 'checkboxes',
  cascadingselect: 'cascading select',
  textfield: 'short text',
  textarea: 'paragraph',
  float: 'number',
  datepicker: 'date',
  datetime: 'date & time',
  userpicker: 'user picker (single)',
  multiuserpicker: 'user picker (multiple)',
  grouppicker: 'group picker (single)',
  multigrouppicker: 'group picker (multiple)',
  labels: 'labels',
  url: 'URL',
  project: 'space picker',
  version: 'version picker (single)',
  multiversion: 'version picker (multiple)',
  readonlyfield: 'read-only text',
  'jsw-story-points': 'story points',
  'gh-sprint': 'sprint',
  'gh-epic-link': 'epic link',
  'jpo-custom-field-baseline-start': 'target start (Plans)',
  'jpo-custom-field-baseline-end': 'target end (Plans)',
  'rm-teams-custom-field-team': 'team (Plans)',
};

/** The types whose values come from per-context options. */
const OPTION_TYPES = new Set([
  'select',
  'multiselect',
  'radiobuttons',
  'multicheckboxes',
  'cascadingselect',
]);

/** `com.atlassian.jira.plugin.system.customfieldtypes:select` → `select`. */
function typeKey(field: Record<string, unknown>): string {
  const custom = str(rec(field.schema).custom);
  return custom.includes(':') ? custom.slice(custom.lastIndexOf(':') + 1) : custom;
}

export function fieldTypeLabel(field: Record<string, unknown>): string {
  const key = typeKey(field);
  return TYPE_LABELS[key] ?? (key || str(rec(field.schema).type) || 'unknown type');
}

function lastUsedNote(field: Record<string, unknown>): string {
  const lastUsed = rec(field.lastUsed);
  if (lastUsed.type === 'TRACKED' && str(lastUsed.value)) {
    return ` — last changed ${str(lastUsed.value).slice(0, 10)}`;
  }
  // Tracked, but Jira has no date: nothing has set it since tracking began.
  if (lastUsed.type === 'NO_INFORMATION') return ' — no recorded use';
  return '';
}

function fieldLine(field: Record<string, unknown>): string {
  const counts: string[] = [];
  if (typeof field.contextsCount === 'number') counts.push(`contexts: ${field.contextsCount}`);
  if (typeof field.screensCount === 'number') counts.push(`screens: ${field.screensCount}`);
  return (
    `${str(field.name) || '(unnamed)'} — ${str(field.id)} — ${fieldTypeLabel(field)}` +
    (counts.length > 0 ? ` — ${counts.join(', ')}` : '') +
    lastUsedNote(field) +
    (field.isLocked === true ? ' — locked (managed by Jira or an app)' : '')
  );
}

type FieldLookup = { ok: true; field: Record<string, unknown> } | { ok: false; reason: string };

/**
 * A custom field by id or by exact name. Names are not unique in Jira, so
 * several exact matches is refused with their ids rather than guessed at —
 * the resolve-user.ts rule, for fields.
 */
export async function findCustomField(
  context: MCPToolContext,
  access: JiraAdminAccess,
  reference: string
): Promise<FieldLookup> {
  const wanted = reference.trim();
  const byId = /^customfield_\d+$/i.test(wanted);
  const query = byId
    ? `id=${encodeURIComponent(wanted.toLowerCase())}`
    : `query=${encodeURIComponent(wanted)}`;
  const result = await jiraAdminGet(
    context,
    access,
    `/rest/api/3/field/search?type=custom&expand=${FIELD_EXPAND}&maxResults=50&${query}`
  );
  if (!result.ok) return { ok: false, reason: result.error };
  const fields = records(result.body);

  if (byId) {
    const match = fields.find((field) => str(field.id).toLowerCase() === wanted.toLowerCase());
    return match
      ? { ok: true, field: match }
      : { ok: false, reason: `No custom field has the id ${wanted}.` };
  }

  const exact = fields.filter(
    (field) => str(field.name).trim().toLowerCase() === wanted.toLowerCase()
  );
  if (exact.length === 1) return { ok: true, field: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      reason:
        `${exact.length} custom fields are named "${wanted}" — pass the id of the one you mean: ` +
        exact.map((field) => `${str(field.id)} (${fieldTypeLabel(field)})`).join(', '),
    };
  }
  const close = fields.slice(0, 5).map((field) => `${str(field.name)} (${str(field.id)})`);
  return {
    ok: false,
    reason:
      `No custom field is named "${wanted}".` +
      (close.length > 0 ? ` Closest: ${close.join(', ')}.` : ''),
  };
}

export async function registerFieldTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_list_fields',
    {
      title: 'Jira Admin · Read — List custom fields',
      description:
        'List the site’s custom fields, by name: id, type, how many contexts and screens use ' +
        'each, and when its value last changed. Search before creating a field — a site ' +
        'usually already has one that fits. Custom fields are site-wide; which spaces and ' +
        'options a field has is per context (jira_admin_get_field).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .describe('Only fields whose name or description contains this (case-insensitive)')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 50)').optional(),
        startAt: z
          .number()
          .int()
          .min(0)
          .describe('Offset of the first field, for the next page (default 0)')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 50;
      const startAt = typeof args.startAt === 'number' ? args.startAt : 0;
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : '';

      const result = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/field/search?type=custom&orderBy=name&expand=${FIELD_EXPAND}` +
          `&startAt=${startAt}&maxResults=${max}` +
          (query ? `&query=${encodeURIComponent(query)}` : '')
      );
      if (!result.ok) return errText(result.error);

      const fields = records(result.body);
      if (fields.length === 0) {
        return textResult(query ? `No custom field matches "${query}".` : 'No custom fields.');
      }
      const page = rec(result.body);
      const total = typeof page.total === 'number' ? page.total : fields.length;
      const end = startAt + fields.length;
      const footer =
        end < total
          ? `\nShowing ${startAt + 1}–${end} of ${total}; pass startAt: ${end} for the next page.`
          : `\n${total} custom field(s)${query ? ` matching "${query}"` : ''}.`;

      return textResult(
        withPresentationHint(
          fields.map(fieldLine).join('\n') + footer,
          'a table (Name, Id, Type, Contexts, Screens, Last changed) usually scans faster than ' +
            'this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'jira_admin_get_field',
    {
      title: 'Jira Admin · Read — Get a custom field’s contexts and options',
      description:
        'One custom field in full: its type, and each of its contexts — which spaces and work ' +
        'types it covers, and the options it offers (select lists, radio buttons, checkboxes, ' +
        'cascading selects). Read this before changing a field’s options: an option belongs ' +
        'to a context, and a global context reaches every space without one of its own.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        field: z
          .string()
          .min(1)
          .describe('The custom field — its id (customfield_10321) or its exact name'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const reference = typeof args.field === 'string' ? args.field : '';
      if (!reference.trim()) return errText('field is required');

      const found = await findCustomField(context, access, reference);
      if (!found.ok) return errText(found.reason);
      const field = found.field;
      const fieldId = encodeURIComponent(str(field.id));

      const [contextsResult, projectMap, typeMap] = await Promise.all([
        jiraAdminGet(context, access, `/rest/api/3/field/${fieldId}/context?maxResults=50`),
        jiraAdminGet(
          context,
          access,
          `/rest/api/3/field/${fieldId}/context/projectmapping?maxResults=50`
        ),
        jiraAdminGet(
          context,
          access,
          `/rest/api/3/field/${fieldId}/context/issuetypemapping?maxResults=50`
        ),
      ]);
      if (!contextsResult.ok) return errText(contextsResult.error);
      const contexts = records(contextsResult.body);
      const shown = contexts.slice(0, MAX_CONTEXTS);

      // Mappings are best-effort: a context still describes without them.
      const projectIdsByContext = new Map<string, string[]>();
      for (const mapping of projectMap.ok ? records(projectMap.body) : []) {
        if (mapping.isGlobalContext === true || !str(mapping.projectId)) continue;
        const key = str(mapping.contextId);
        projectIdsByContext.set(key, [
          ...(projectIdsByContext.get(key) ?? []),
          str(mapping.projectId),
        ]);
      }
      const typeIdsByContext = new Map<string, string[]>();
      for (const mapping of typeMap.ok ? records(typeMap.body) : []) {
        if (mapping.isAnyIssueType === true || !str(mapping.issueTypeId)) continue;
        const key = str(mapping.contextId);
        typeIdsByContext.set(key, [...(typeIdsByContext.get(key) ?? []), str(mapping.issueTypeId)]);
      }

      const projectIds = [...new Set([...projectIdsByContext.values()].flat())].slice(0, 50);
      const hasOptions = OPTION_TYPES.has(typeKey(field));
      const [projects, workTypes, ...optionPages] = await Promise.all([
        projectIds.length > 0
          ? jiraAdminGet(
              context,
              access,
              `/rest/api/3/project/search?maxResults=50&${projectIds.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`
            )
          : Promise.resolve(null),
        typeIdsByContext.size > 0
          ? jiraAdminGet(context, access, '/rest/api/3/issuetype')
          : Promise.resolve(null),
        ...(hasOptions
          ? shown.map((ctx) =>
              jiraAdminGet(
                context,
                access,
                `/rest/api/3/field/${fieldId}/context/${encodeURIComponent(str(ctx.id))}/option?maxResults=${MAX_OPTIONS}`
              )
            )
          : []),
      ]);

      const projectKey = new Map<string, string>();
      for (const project of projects?.ok ? records(projects.body) : []) {
        projectKey.set(str(project.id), str(project.key));
      }
      const typeName = new Map<string, string>();
      for (const workType of workTypes?.ok ? records(workTypes.body) : []) {
        typeName.set(str(workType.id), str(workType.name));
      }

      const lines = [`${str(field.name)} — ${str(field.id)} — ${fieldTypeLabel(field)}`];
      if (str(field.description)) lines.push(`Description: ${str(field.description)}`);
      if (field.isLocked === true) {
        lines.push('Locked: managed by Jira or an app, so its configuration cannot be changed.');
      }
      lines.push(
        '',
        contexts.length === 0
          ? 'No contexts — the field applies nowhere until one is added.'
          : `${contexts.length} context(s)` +
              (contexts.length > shown.length ? ` (first ${shown.length} shown)` : '') +
              ':'
      );

      shown.forEach((ctx, index) => {
        const id = str(ctx.id);
        const spaces =
          ctx.isGlobalContext === true
            ? 'every space'
            : `spaces: ${(projectIdsByContext.get(id) ?? []).map((pid) => projectKey.get(pid) || `id ${pid}`).join(', ') || '(none mapped)'}`;
        const types =
          ctx.isAnyIssueType === true
            ? 'every work type'
            : `work types: ${(typeIdsByContext.get(id) ?? []).map((tid) => typeName.get(tid) || `id ${tid}`).join(', ') || '(none mapped)'}`;
        lines.push(`• ${str(ctx.name) || '(unnamed)'} (id ${id}) — ${spaces} · ${types}`);
        if (ctx.isGlobalContext === true) {
          lines.push(
            '  Global: an option added here shows up in every space without a context of its own.'
          );
        }
        if (!hasOptions) return;
        const page = optionPages[index];
        if (!page || !page.ok) {
          lines.push(`  Options: could not be read${page && !page.ok ? ` (${page.error})` : ''}`);
          return;
        }
        const options = records(page.body);
        const parents = new Map(options.map((option) => [str(option.id), str(option.value)]));
        const labels = options.map((option) => {
          const parent = str(option.optionId);
          const label = parent
            ? `${parents.get(parent) ?? parent} › ${str(option.value)}`
            : str(option.value);
          return option.disabled === true ? `${label} (disabled)` : label;
        });
        const total =
          typeof rec(page.body).total === 'number' ? Number(rec(page.body).total) : options.length;
        lines.push(
          options.length === 0
            ? '  Options: none'
            : `  Options (${total}): ${labels.join(' · ')}` +
                (total > options.length ? ` · …and ${total - options.length} more` : '')
        );
      });

      return textResult(lines.join('\n'));
    }
  );
}
