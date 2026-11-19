/**
 * Changing a SharePoint list's shape: creating a list, adding a column,
 * removing one.
 *
 * These stand on Sites.Manage.All, not the Sites.ReadWrite.All the item
 * tools use (see lists.ts): Graph puts creating lists and their columns a
 * permission above writing their rows, and an org can grant one without the
 * other.
 *
 * Graph's column definition is a type FACET object (`text: {}`,
 * `choice: { choices }`, `dateTime: { format }` …) rather than a type name,
 * with a few settings that only make sense on some facets. The model is
 * given a flat spec — a type name and the settings a person would mention —
 * and `columnDefinition` builds the facet here, refusing a spec that would
 * otherwise reach Graph half-formed (a choice column with no choices).
 *
 * Removing a column takes every item's value in it with it, and SharePoint
 * has no recycle bin for columns. The tool says so, the preview card says
 * so, and it needs approval. Built-in columns (Title, read-only and sealed
 * ones) are refused before Graph is asked.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import {
  graphGet,
  graphPost,
  graphDelete,
  values,
  str,
  rec,
  textResult,
  errText,
} from '../graph/client';
import { resolveSite } from '../graph/resolve';
import { failed, resolveList } from './lists';

export const COLUMN_TYPES = [
  'text',
  'multilineText',
  'number',
  'currency',
  'choice',
  'multiChoice',
  'dateTime',
  'dateOnly',
  'boolean',
  'person',
  'hyperlink',
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface ColumnSpec {
  displayName: string;
  name?: string;
  type: ColumnType;
  choices?: string[];
  required?: boolean;
  description?: string;
  indexed?: boolean;
}

export const LIST_TEMPLATES = [
  'genericList',
  'issueTracking',
  'events',
  'contacts',
  'links',
  'announcements',
] as const;

/** SharePoint caps an internal column name at 32 characters. */
const MAX_INTERNAL_NAME = 32;

/**
 * The internal name SharePoint would otherwise mint from the display name
 * (spaces become `_x0020_`, which every later write then has to spell).
 * Letters and digits only, starting with a letter.
 */
export function internalNameFor(displayName: string): string {
  return displayName
    .replace(/[^A-Za-z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, MAX_INTERNAL_NAME);
}

/** A flat column spec → Graph's columnDefinition, or why it cannot be one. */
export function columnDefinition(
  spec: ColumnSpec
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const displayName = spec.displayName.trim();
  if (!displayName) return { ok: false, error: 'A column needs a displayName.' };

  const name = spec.name?.trim() || internalNameFor(displayName);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.length > MAX_INTERNAL_NAME) {
    return {
      ok: false,
      error:
        `"${displayName}" needs an internal name of letters, digits and underscores, starting ` +
        `with a letter and at most ${MAX_INTERNAL_NAME} characters; give one as \`name\`.`,
    };
  }
  if (name.toLowerCase() === 'title' || name.toLowerCase() === 'id') {
    return {
      ok: false,
      error: `Every list already has a ${name} column; name this one differently.`,
    };
  }

  const choices = (spec.choices ?? []).map((choice) => choice.trim()).filter(Boolean);
  const isChoice = spec.type === 'choice' || spec.type === 'multiChoice';
  if (isChoice && choices.length === 0) {
    return { ok: false, error: `"${displayName}" is a ${spec.type} column, so it needs choices.` };
  }
  if (!isChoice && choices.length > 0) {
    return {
      ok: false,
      error: `"${displayName}" is a ${spec.type} column; only a choice or multiChoice column takes choices.`,
    };
  }

  const facet: Record<ColumnType, Record<string, unknown>> = {
    text: { text: {} },
    multilineText: { text: { allowMultipleLines: true } },
    number: { number: {} },
    currency: { currency: {} },
    choice: { choice: { choices, displayAs: 'dropDownMenu', allowTextEntry: false } },
    multiChoice: { choice: { choices, displayAs: 'checkBoxes', allowTextEntry: false } },
    dateTime: { dateTime: { format: 'dateTime' } },
    dateOnly: { dateTime: { format: 'dateOnly' } },
    boolean: { boolean: {} },
    person: { personOrGroup: { allowMultipleSelection: false, chooseFromType: 'peopleOnly' } },
    hyperlink: { hyperlinkOrPicture: { isPicture: false } },
  };

  return {
    ok: true,
    body: {
      name,
      displayName,
      ...(spec.description?.trim() ? { description: spec.description.trim() } : {}),
      ...(spec.required === true ? { required: true } : {}),
      ...(spec.indexed === true ? { indexed: true } : {}),
      ...facet[spec.type],
    },
  };
}

/** One line per column for an answer: "Status (choice: Open, Done) — internal name: Status". */
function describeColumn(body: Record<string, unknown>, type: ColumnType): string {
  const choices = rec(body.choice).choices;
  return (
    `${str(body.displayName)} (${type}${Array.isArray(choices) ? `: ${choices.join(', ')}` : ''}` +
    `${body.required === true ? ', required' : ''}) — internal name: ${str(body.name)}`
  );
}

const columnSpecSchema = z.object({
  displayName: z.string().min(1).describe('The column name people see, e.g. "Due Date".'),
  name: z
    .string()
    .describe(
      'Internal name (letters, digits, underscores). Omit to derive one from displayName ' +
        'without spaces, e.g. DueDate.'
    )
    .optional(),
  type: z
    .enum(COLUMN_TYPES)
    .describe(
      'text, multilineText, number, currency, choice (pick one), multiChoice (pick several), ' +
        'dateTime, dateOnly, boolean (yes/no), person, hyperlink.'
    ),
  choices: z.array(z.string()).describe('The options, for choice and multiChoice only.').optional(),
  required: z.boolean().describe('Whether every item must fill it in.').optional(),
  description: z.string().describe('Help text shown under the column.').optional(),
  indexed: z
    .boolean()
    .describe('Index it, so a large list can be filtered and sorted on it.')
    .optional(),
});

function specOf(value: unknown): ColumnSpec {
  const raw = rec(value);
  return {
    displayName: str(raw.displayName),
    name: str(raw.name) || undefined,
    type: COLUMN_TYPES.find((type) => type === str(raw.type)) ?? 'text',
    choices: Array.isArray(raw.choices) ? raw.choices.map(str) : undefined,
    required: raw.required === true,
    description: str(raw.description) || undefined,
    indexed: raw.indexed === true,
  };
}

export function registerListSchemaTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): void {
  server.registerTool(
    'sharepoint_create_list',
    {
      title: 'SharePoint · Act — Create a list',
      description:
        'Create a SharePoint list on a site, optionally with its columns. Every list comes with ' +
        'a Title column, so do not add one. Items are then added with sharepoint_create_list_item ' +
        'using the internal names this returns.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        displayName: z.string().min(1).describe('The list’s name, e.g. "Project Tracker".'),
        description: z.string().describe('What the list is for.').optional(),
        template: z
          .enum(LIST_TEMPLATES)
          .describe('genericList (default) for a custom list, or a built-in kind.')
          .optional(),
        columns: z.array(columnSpecSchema).max(30).describe('Columns besides Title.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const displayName = str(args.displayName).trim();
      if (!displayName) return errText('Give the list a name; nothing was created.');

      const specs = Array.isArray(args.columns) ? args.columns.map(specOf) : [];
      const columns: { body: Record<string, unknown>; type: ColumnType }[] = [];
      for (const spec of specs) {
        const built = columnDefinition(spec);
        if (!built.ok) return errText(failed(built.error, 'Nothing was created.'));
        columns.push({ body: built.body, type: spec.type });
      }
      const names = columns.map((column) => str(column.body.name).toLowerCase());
      const repeated = names.find((name, index) => names.indexOf(name) !== index);
      if (repeated) {
        return errText(`Two columns share the internal name "${repeated}". Nothing was created.`);
      }

      const site = await resolveSite(context, access.auth, str(args.site));
      if (!site.ok) return errText(site.error);

      const template =
        LIST_TEMPLATES.find((candidate) => candidate === str(args.template)) ?? 'genericList';
      const created = await graphPost(context, access.auth, `/sites/${site.siteId}/lists`, {
        displayName,
        ...(str(args.description) ? { description: str(args.description) } : {}),
        ...(columns.length > 0 ? { columns: columns.map((column) => column.body) } : {}),
        list: { template },
      });
      if (!created.ok) {
        return errText(
          failed(
            created.error,
            created.error.includes('409')
              ? 'The list was not created; the site may already have a list with that name.'
              : 'The list was not created.'
          )
        );
      }

      return textResult(
        `Created the list "${str(created.body.displayName) || displayName}" on ${site.name}.\n` +
          `listId: ${str(created.body.id)}` +
          (str(created.body.webUrl) ? `\n${str(created.body.webUrl)}` : '') +
          (columns.length > 0
            ? `\n\nColumns besides Title:\n${columns.map((column) => `  • ${describeColumn(column.body, column.type)}`).join('\n')}`
            : '')
      );
    }
  );

  server.registerTool(
    'sharepoint_add_list_column',
    {
      title: 'SharePoint · Act — Add a column to a list',
      description:
        'Add a column to a SharePoint list or document library. Existing items get it empty ' +
        '(so a required column is only enforced on later edits). Returns the internal name item ' +
        'writes need.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z
          .string()
          .describe('Site URL or id. Optional when `list` is the list’s full URL.')
          .optional(),
        list: z.string().min(1).describe('The list’s title, its id, or its URL.'),
        column: columnSpecSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const spec = specOf(args.column);
      const built = columnDefinition(spec);
      if (!built.ok) return errText(failed(built.error, 'No column was added.'));

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;

      const created = await graphPost(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/columns`,
        built.body
      );
      if (!created.ok) {
        return errText(
          failed(
            created.error,
            created.error.includes('409')
              ? `No column was added; ${list.name} may already have a column with that name.`
              : `No column was added to ${list.name}.`
          )
        );
      }

      return textResult(
        `Added a column to ${list.name}: ${describeColumn({ ...built.body, ...created.body }, spec.type)}.`
      );
    }
  );

  server.registerTool(
    'sharepoint_remove_list_column',
    {
      title: 'SharePoint · Act — Remove a column from a list',
      description:
        'Remove a column from a SharePoint list or library, by its display or internal name. ' +
        'Every item’s value in that column is deleted with it and cannot be restored — SharePoint ' +
        'has no recycle bin for columns. Built-in columns (Title, read-only ones) cannot be removed.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        site: z
          .string()
          .describe('Site URL or id. Optional when `list` is the list’s full URL.')
          .optional(),
        list: z.string().min(1).describe('The list’s title, its id, or its URL.'),
        column: z.string().min(1).describe('The column’s display name or internal name.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const wanted = str(args.column).trim().toLowerCase();
      if (!wanted) return errText('Name the column to remove; nothing was removed.');

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;

      const columns = await graphGet(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/columns`
      );
      if (!columns.ok) return errText(failed(columns.error, 'Nothing was removed.'));

      const all = values(columns.body);
      const removable = (column: Record<string, unknown>) =>
        column.readOnly !== true &&
        column.sealed !== true &&
        column.hidden !== true &&
        !str(column.name).startsWith('_') &&
        str(column.name).toLowerCase() !== 'title';
      const match =
        all.find((column) => str(column.name).toLowerCase() === wanted) ??
        all.find((column) => str(column.displayName).toLowerCase() === wanted);

      if (!match) {
        const names = all.filter(removable).map((column) => str(column.displayName));
        return errText(
          `${list.name} has no column named "${str(args.column)}". Columns that can be removed: ` +
            `${names.join(', ') || 'none'}. Nothing was removed.`
        );
      }
      if (!removable(match)) {
        return errText(
          `"${str(match.displayName)}" is a built-in column of ${list.name} and cannot be ` +
            'removed. Nothing was removed.'
        );
      }

      const deleted = await graphDelete(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/columns/${encodeURIComponent(str(match.id))}`
      );
      if (!deleted.ok) return errText(failed(deleted.error, 'The column was not removed.'));

      return textResult(
        `Removed the column "${str(match.displayName)}" (internal name ${str(match.name)}) from ` +
          `${list.name}, with every item’s value in it.`
      );
    }
  );
}
