/**
 * SharePoint lists — the rows people keep on a site that are not documents:
 * trackers, issue logs, contacts, calendars, tasks, announcements.
 *
 * Four facts about Graph's list API shape these tools:
 *
 *   - A list is named by people by its title ("Project Tracker"), by Graph by
 *     a GUID. Every tool takes either (or the list's pasted URL) and resolves
 *     it here, against the site's lists, so the model never has to carry a
 *     GUID it could transcribe wrong.
 *   - An item's values live under `fields`, keyed by INTERNAL column names,
 *     exactly as a library's metadata does (see metadata.ts). A column shown
 *     as "Due Date" may be `DueDate` or `Due_x0020_Date`, so
 *     `sharepoint_get_list` reports both and the write tools say to use it.
 *   - Filtering on a column the list has not indexed is refused by Graph
 *     unless the request carries `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`.
 *     Small lists are the common case and are fine with it, so the query
 *     tool always sends it; a very large list may still refuse, and the
 *     error says so.
 *   - Creating a list or a column is a different permission
 *     (Sites.Manage.All) from writing items (Sites.ReadWrite.All). This file
 *     only reads lists and writes their items; changing a list's shape stays
 *     in SharePoint until that grant is offered.
 *
 * Document libraries are lists too, and Graph returns them from /lists. They
 * are marked as libraries in the listing and pointed at the document tools,
 * whose path-and-file handling an item write would bypass.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuthedFetch } from '@renkei/delegate-client';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import type { GraphCallContext } from '../graph/client';
import { withPresentationHint } from '../common';
import {
  graphGet,
  graphPost,
  graphPatch,
  graphDelete,
  values,
  str,
  num,
  rec,
  textResult,
  errText,
} from '../graph/client';
import { resolveSite } from '../graph/resolve';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lets Graph filter and sort on columns the list has not indexed. */
const NON_INDEXED = { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' };

/**
 * Fields every item carries that say nothing a person asked about. Shown,
 * they bury the three columns the list is actually for.
 */
const NOISE = new Set([
  'ContentType',
  'Edit',
  'LinkTitle',
  'LinkTitleNoMenu',
  'ItemChildCount',
  'FolderChildCount',
  'AppAuthorLookupId',
  'AppEditorLookupId',
  'Attachments',
  'DocIcon',
  'ComplianceAssetId',
]);

export interface ListRef {
  siteId: string;
  listId: string;
  name: string;
  webUrl: string;
  /** Graph's template name: genericList, documentLibrary, events, tasks … */
  template: string;
}

const listFields = {
  site: z
    .string()
    .describe('Site URL or id. Optional when `list` is the list’s full URL.')
    .optional(),
  list: z.string().min(1).describe('The list’s title (as shown on the site), its id, or its URL.'),
};

/**
 * A site and a list title, id or URL → the list's ids. A pasted list URL
 * (…/sites/eng/Lists/Tracker/AllItems.aspx) carries its own site.
 */
export async function resolveList(
  context: GraphCallContext,
  auth: AuthedFetch,
  site: string,
  list: string
): Promise<{ ok: true; list: ListRef } | { ok: false; error: string }> {
  const wanted = list.trim();
  if (!wanted) return { ok: false, error: 'Name a list.' };
  const isUrl = wanted.startsWith('https://');
  const siteGiven = site.trim() || (isUrl ? wanted : '');
  if (!siteGiven) return { ok: false, error: 'Give a site (or the list’s full URL).' };

  const resolvedSite = await resolveSite(context, auth, siteGiven);
  if (!resolvedSite.ok) return resolvedSite;
  const siteId = resolvedSite.siteId;

  const toRef = (entry: Record<string, unknown>): ListRef => ({
    siteId,
    listId: str(entry.id),
    name: str(entry.displayName) || str(entry.name),
    webUrl: str(entry.webUrl),
    template: str(rec(entry.list).template),
  });

  if (GUID.test(wanted)) {
    const found = await graphGet(
      context,
      auth,
      `/sites/${siteId}/lists/${wanted}?$select=id,displayName,name,webUrl,list`
    );
    if (!found.ok) return { ok: false, error: found.error };
    return { ok: true, list: toRef(found.body) };
  }

  const all = await graphGet(
    context,
    auth,
    `/sites/${siteId}/lists?$select=id,displayName,name,webUrl,list`
  );
  if (!all.ok) return { ok: false, error: all.error };
  const lists = values(all.body);

  const match = isUrl
    ? lists.find((entry) => urlInside(wanted, str(entry.webUrl)))
    : lists.find(
        (entry) =>
          str(entry.displayName).toLowerCase() === wanted.toLowerCase() ||
          str(entry.name).toLowerCase() === wanted.toLowerCase()
      );
  if (match) return { ok: true, list: toRef(match) };

  const names = lists
    .filter((entry) => rec(entry.list).hidden !== true)
    .map((entry) => str(entry.displayName))
    .filter(Boolean);
  return {
    ok: false,
    error:
      `No list ${isUrl ? 'at that address' : `named "${wanted}"`} on ${resolvedSite.name || 'that site'}. ` +
      `Available: ${names.join(', ') || 'none'}.`,
  };
}

/** True when `url` is the list at `listUrl` or a view or item inside it. */
function urlInside(url: string, listUrl: string): boolean {
  if (!listUrl) return false;
  const norm = (value: string) => {
    try {
      return decodeURIComponent(new URL(value).pathname).replace(/\/+$/, '').toLowerCase();
    } catch {
      return '';
    }
  };
  const target = norm(url);
  const base = norm(listUrl);
  return base !== '' && (target === base || target.startsWith(`${base}/`));
}

/** The item fields worth showing: no OData annotations, no system noise. */
export function shownFields(fields: Record<string, unknown>): [string, unknown][] {
  return Object.entries(fields).filter(
    ([key, value]) =>
      !key.startsWith('@') &&
      !key.startsWith('_') &&
      !key.startsWith('OData_') &&
      !NOISE.has(key) &&
      value !== null &&
      value !== ''
  );
}

function itemLines(item: Record<string, unknown>): string {
  const fields = rec(item.fields);
  const title = str(fields.Title) || '(untitled)';
  const rest = shownFields(fields)
    .filter(([key]) => key !== 'Title' && key !== 'id')
    .map(
      ([key, value]) => `    ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
    );
  return [`${title}`, `    itemId: ${str(item.id)}`, ...rest].join('\n');
}

/** Name the column's type from whichever type facet it carries. */
function columnType(column: Record<string, unknown>): string {
  for (const kind of [
    'text',
    'choice',
    'number',
    'dateTime',
    'boolean',
    'personOrGroup',
    'lookup',
    'currency',
    'hyperlinkOrPicture',
    'term',
    'calculated',
  ]) {
    if (column[kind] !== undefined) return kind;
  }
  return 'unknown';
}

/**
 * The next page, as a token the model hands back unchanged.
 *
 * It carries Graph's whole next-page query (filter, sort, columns, page size
 * and skiptoken together), not the skiptoken alone, so the follow-up call
 * cannot drift from the first one: a skiptoken replayed with a different
 * filter or sort lands on the wrong page or is refused. It also names its
 * list, and is only ever replayed against a path built here — never the
 * nextLink's own host or path — so a token cannot point a call anywhere else.
 */
export function pageTokenOf(listId: string, body: Record<string, unknown>): string {
  const next = str(body['@odata.nextLink']);
  if (!next) return '';
  try {
    const query = new URL(next).searchParams.toString();
    if (!query) return '';
    return Buffer.from(JSON.stringify({ l: listId, q: query }), 'utf8').toString('base64url');
  } catch {
    return '';
  }
}

/** The query a pageToken stands for, or null when it is not one of this list's. */
export function queryOfPageToken(listId: string, token: string): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const decoded = rec(parsed);
    if (str(decoded.l) !== listId || !str(decoded.q)) return null;
    return new URLSearchParams(str(decoded.q)).toString();
  } catch {
    return null;
  }
}

/** Whether a query filters or sorts — what a large list refuses on unindexed columns. */
function narrowed(query: string): boolean {
  const params = new URLSearchParams(query);
  return params.has('$filter') || params.has('$orderby');
}

/**
 * Graph's error, then what did not happen. describeStatus ends some answers
 * without a full stop ("Microsoft Graph answered 409"), so one is added.
 */
export function failed(error: string, outcome: string): string {
  return `${/[.!?)]$/.test(error.trim()) ? error.trim() : `${error.trim()}.`} ${outcome}`;
}

const LIBRARY_HINT =
  'That is a document library — use the sharepoint_*_document tools (and ' +
  'sharepoint_update_document_metadata for its columns) instead.';

export function registerListTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): void {
  server.registerTool(
    'sharepoint_list_lists',
    {
      title: 'SharePoint · Read — List a site’s lists',
      description:
        'The lists on a SharePoint site (trackers, issue logs, contacts, tasks, calendars), with ' +
        'the title every sharepoint_*_list_item tool accepts. Document libraries are marked; ' +
        'hidden system lists are left out.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.auth, str(args.site));
      if (!resolved.ok) return errText(resolved.error);

      const found = await graphGet(
        context,
        access.auth,
        `/sites/${resolved.siteId}/lists?$select=id,displayName,description,webUrl,list,lastModifiedDateTime`
      );
      if (!found.ok) return errText(found.error);

      const lists = values(found.body).filter((entry) => rec(entry.list).hidden !== true);
      if (lists.length === 0) return textResult(`${resolved.name} has no lists.`);

      const lines = lists.map((entry) => {
        const template = str(rec(entry.list).template);
        const kind = template === 'documentLibrary' ? 'document library' : template || 'list';
        return (
          `${str(entry.displayName)} (${kind})\n    ${str(entry.webUrl)}\n    listId: ${str(entry.id)}` +
          (str(entry.description) ? `\n    ${str(entry.description)}` : '')
        );
      });
      return textResult(
        withPresentationHint(
          `${resolved.name} — ${lists.length} list(s)\n\n${lines.join('\n')}`,
          'Render as a list of lists with links.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_get_list',
    {
      title: 'SharePoint · Read — Describe a list and its columns',
      description:
        'A SharePoint list’s columns with the INTERNAL names the list item tools need as keys, ' +
        'their types, which are required or read-only, and a choice column’s allowed values. Call ' +
        'this before creating, updating or filtering items rather than guessing column names.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object(listFields),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;

      const columns = await graphGet(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/columns`
      );
      if (!columns.ok) return errText(columns.error);

      const entries = values(columns.body).filter(
        (column) => column.hidden !== true && !str(column.name).startsWith('_')
      );
      const lines = entries.map((column) => {
        const flags = [
          column.readOnly === true ? 'read-only' : '',
          column.required === true ? 'required' : '',
          column.indexed === true ? 'indexed' : '',
        ].filter(Boolean);
        const rawChoices = rec(column.choice).choices;
        const choices = Array.isArray(rawChoices)
          ? ` — choices: ${rawChoices.map(String).join(', ')}`
          : '';
        return (
          `${str(column.displayName)} (${columnType(column)}${flags.length ? `, ${flags.join(', ')}` : ''})\n` +
          `    internal name: ${str(column.name)}${choices}`
        );
      });
      const header =
        `${list.name}${list.template ? ` (${list.template})` : ''}\n${list.webUrl}\n` +
        `listId: ${list.listId}` +
        (list.template === 'documentLibrary' ? `\n${LIBRARY_HINT}` : '');
      return textResult(
        withPresentationHint(
          `${header}\n\n${entries.length} column(s)\n\n${lines.join('\n')}`,
          'Render as a list of columns with their internal names.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_list_items',
    {
      title: 'SharePoint · Read — List or query a list’s items',
      description:
        'Items in a SharePoint list, with each item’s itemId and column values. Narrow with an ' +
        "OData `filter` on INTERNAL column names prefixed by fields/, e.g. fields/Status eq 'Open' " +
        "or fields/DueDate lt '2026-12-01'. When more items remain the answer carries a pageToken: " +
        'for the next page pass it back with the same list, unchanged — it already holds the ' +
        'filter, sort, columns and page size, so those are ignored alongside it. On a list past ' +
        '5,000 items, filter and sort only on indexed columns (sharepoint_get_list marks them).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        ...listFields,
        filter: z
          .string()
          .describe("OData filter, e.g. fields/Status eq 'Open'. Omit for every item.")
          .optional(),
        orderBy: z
          .string()
          .describe('Sort, e.g. fields/Modified desc. Omit for the list’s own order.')
          .optional(),
        columns: z
          .array(z.string())
          .describe('Internal names of the columns to return; omit for all.')
          .optional(),
        max: z.number().int().min(1).max(200).describe('How many (default 50).').optional(),
        pageToken: z
          .string()
          .describe('The pageToken a previous call on this list returned, unchanged.')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;

      let query: string;
      const token = str(args.pageToken);
      if (token) {
        const replayed = queryOfPageToken(list.listId, token);
        if (replayed === null) {
          return errText(
            `That pageToken does not belong to ${list.name}. Pass back the token exactly as a ` +
              'previous sharepoint_list_items call on this list returned it, or omit it to start over.'
          );
        }
        query = replayed;
      } else {
        const columns = Array.isArray(args.columns)
          ? args.columns.map(str).filter((name) => /^[A-Za-z0-9_]+$/.test(name))
          : [];
        if (columns.length > 0 && !columns.includes('Title')) columns.unshift('Title');
        const params = new URLSearchParams({
          $expand: columns.length > 0 ? `fields($select=${columns.join(',')})` : 'fields',
          $top: String(num(args.max) ?? 50),
        });
        if (str(args.filter)) params.set('$filter', str(args.filter));
        if (str(args.orderBy)) params.set('$orderby', str(args.orderBy));
        query = params.toString();
      }

      const found = await graphGet(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/items?${query}`,
        NON_INDEXED
      );
      if (!found.ok) {
        return errText(
          narrowed(query)
            ? failed(
                found.error,
                'If the list is large, filter or sort on an indexed column (sharepoint_get_list marks them).'
              )
            : found.error
        );
      }

      const items = values(found.body);
      const next = pageTokenOf(list.listId, found.body);
      if (items.length === 0) {
        return textResult(
          new URLSearchParams(query).has('$filter')
            ? `No items in ${list.name} match that filter.`
            : `${list.name} is empty.`
        );
      }
      return textResult(
        withPresentationHint(
          `${list.name} — ${items.length} item(s)${next ? ' (more remain)' : ''}\n\n` +
            items.map(itemLines).join('\n') +
            (next ? `\n\npageToken: ${next}` : ''),
          'Render as a table of items, one row each, with the columns shown.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_get_list_item',
    {
      title: 'SharePoint · Read — Read one list item',
      description: 'Every column value on one SharePoint list item, by its itemId.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        ...listFields,
        itemId: z.string().min(1).describe('The item’s id, from sharepoint_list_items.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;

      const found = await graphGet(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/items/${encodeURIComponent(str(args.itemId))}?$expand=fields`
      );
      if (!found.ok) return errText(found.error);

      const fields = rec(found.body.fields);
      const lines = shownFields(fields).map(
        ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
      );
      return textResult(
        withPresentationHint(
          `${str(fields.Title) || 'Item'} in ${list.name}\n${str(found.body.webUrl)}\n` +
            `itemId: ${str(found.body.id)}\n\n${lines.join('\n')}`,
          'Render as a property list.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_create_list_item',
    {
      title: 'SharePoint · Act — Add an item to a list',
      description:
        'Add a row to a SharePoint list. Keys are INTERNAL column names from sharepoint_get_list ' +
        '(display names will not work); most lists require Title. A choice column takes one of its ' +
        'listed choices; a person or lookup column takes the id under its …LookupId name.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...listFields,
        fields: z
          .record(z.string(), z.unknown())
          .describe('Column internal name → value, e.g. {"Title":"Fix login","Status":"Open"}.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const fields = rec(args.fields);
      if (Object.keys(fields).length === 0) return errText('No fields given; nothing was added.');

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;
      if (list.template === 'documentLibrary') return errText(LIBRARY_HINT);

      const created = await graphPost(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/items`,
        { fields }
      );
      if (!created.ok) return errText(failed(created.error, `Nothing was added to ${list.name}.`));

      const title = str(rec(created.body.fields).Title) || str(fields.Title);
      return textResult(
        `Added ${title ? `"${title}"` : 'an item'} to ${list.name}.\n` +
          `itemId: ${str(created.body.id)}` +
          (str(created.body.webUrl) ? `\n${str(created.body.webUrl)}` : '')
      );
    }
  );

  server.registerTool(
    'sharepoint_update_list_item',
    {
      title: 'SharePoint · Act — Change a list item',
      description:
        'Set column values on an existing SharePoint list item; columns not named keep their ' +
        'values. Keys are INTERNAL column names from sharepoint_get_list. Read-only and computed ' +
        'columns are refused by SharePoint.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...listFields,
        itemId: z.string().min(1).describe('The item’s id, from sharepoint_list_items.'),
        fields: z
          .record(z.string(), z.unknown())
          .describe('Column internal name → new value, e.g. {"Status":"Done"}.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const fields = rec(args.fields);
      if (Object.keys(fields).length === 0) return errText('No fields given; nothing was changed.');

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;

      const updated = await graphPatch(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/items/${encodeURIComponent(str(args.itemId))}/fields`,
        fields
      );
      if (!updated.ok) return errText(failed(updated.error, 'The item was not changed.'));

      const title = str(updated.body.Title);
      return textResult(
        `Updated ${Object.keys(fields).length} field(s) on ${title ? `"${title}"` : 'the item'} ` +
          `in ${list.name}: ${Object.keys(fields).join(', ')}.`
      );
    }
  );

  server.registerTool(
    'sharepoint_delete_list_item',
    {
      title: 'SharePoint · Act — Delete a list item',
      description:
        'Delete one item from a SharePoint list. It goes to the site’s recycle bin, where a site ' +
        'owner can restore it.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        ...listFields,
        itemId: z.string().min(1).describe('The item’s id, from sharepoint_list_items.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveList(context, access.auth, str(args.site), str(args.list));
      if (!resolved.ok) return errText(resolved.error);
      const { list } = resolved;
      if (list.template === 'documentLibrary') return errText(LIBRARY_HINT);

      const deleted = await graphDelete(
        context,
        access.auth,
        `/sites/${list.siteId}/lists/${list.listId}/items/${encodeURIComponent(str(args.itemId))}`
      );
      if (!deleted.ok) return errText(failed(deleted.error, 'The item was not deleted.'));
      return textResult(`Deleted item ${str(args.itemId)} from ${list.name}.`);
    }
  );
}
