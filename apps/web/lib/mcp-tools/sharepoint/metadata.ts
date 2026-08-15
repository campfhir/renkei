/**
 * SharePoint column metadata — what people mean by "tags" on a document.
 *
 * There is no generic tag API. A document's metadata is the set of COLUMNS
 * its library defines: managed metadata, choice fields, person fields, plain
 * text. Two facts make listing columns a real tool rather than a convenience:
 *
 *   - Internal names are not display names. A column shown as "Document
 *     Status" may be `Document_x0020_Status` or `DocStatus`, and writing to
 *     the wrong one fails or silently does nothing.
 *   - Not everything is writable. Read-only and computed columns exist, and
 *     managed-metadata columns want a term object rather than a string.
 *
 * So `sharepoint_list_columns` is not optional: without it, updating metadata
 * is guesswork.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import { withPresentationHint } from '../common';
import { graphGet, graphPatch, values, str, rec, textResult, errText } from '../graph/client';
import { resolveDriveItem, type ItemSelector } from '../graph/resolve';

function selectorOf(args: Record<string, unknown>): ItemSelector {
  return {
    itemUrl: str(args.itemUrl) || undefined,
    driveId: str(args.driveId) || undefined,
    itemId: str(args.itemId) || undefined,
    path: str(args.path) || undefined,
    site: str(args.site) || undefined,
    library: str(args.library) || undefined,
  };
}

const selectorFields = {
  itemUrl: z.string().describe('A pasted link to the document.').optional(),
  driveId: z.string().describe('Drive id.').optional(),
  itemId: z.string().describe('Item id.').optional(),
  path: z.string().describe('Path inside the library.').optional(),
  site: z.string().describe('Site URL or id.').optional(),
  library: z.string().describe('Library name.').optional(),
};

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
  ]) {
    if (column[kind] !== undefined) return kind;
  }
  return 'unknown';
}

export function registerMetadataTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): void {
  server.registerTool(
    'sharepoint_list_columns',
    {
      title: 'SharePoint · Read — List a library’s metadata columns',
      description:
        'The columns a document library defines, with the INTERNAL names ' +
        'sharepoint_update_document_metadata needs. Display names differ from internal names, ' +
        'so call this before writing metadata rather than guessing.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        site: z.string().describe('Site URL or id.').optional(),
        library: z.string().describe('Library name; omit for the site default.').optional(),
        driveId: z.string().describe('Drive id, instead of site+library.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      let driveId = str(args.driveId);
      if (!driveId) {
        if (!str(args.site)) return errText('Give a site (or a driveId).');
        const resolved = await resolveDriveItem(context, access.accessToken, {
          site: str(args.site),
          library: str(args.library) || undefined,
        });
        if (!resolved.ok) return errText(resolved.error);
        driveId = resolved.item.driveId;
      }

      const columns = await graphGet(
        context,
        access.accessToken,
        `/drives/${driveId}/list/columns`
      );
      if (!columns.ok) return errText(columns.error);

      const entries = values(columns.body).filter((column) => !str(column.name).startsWith('_'));
      if (entries.length === 0) return textResult('That library defines no custom columns.');

      const lines = entries.map((column) => {
        const flags = [
          column.readOnly === true ? 'read-only' : '',
          column.required === true ? 'required' : '',
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
      return textResult(
        withPresentationHint(
          `${entries.length} column(s)\n\n${lines.join('\n')}`,
          'Render as a list of columns with their internal names.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_get_document_metadata',
    {
      title: 'SharePoint · Read — Read a document’s metadata',
      description:
        'The SharePoint column values on a document — content type, tags, custom fields.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object(selectorFields),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveDriveItem(context, access.accessToken, selectorOf(args));
      if (!resolved.ok) return errText(resolved.error);

      const listItem = await graphGet(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}/listItem?$expand=fields`
      );
      if (!listItem.ok) return errText(listItem.error);

      const fields = rec(listItem.body.fields);
      const shown = Object.entries(fields).filter(
        ([key]) => !key.startsWith('@') && !key.startsWith('_')
      );
      if (shown.length === 0)
        return textResult(`"${resolved.item.name}" has no column values set.`);

      const lines = shown.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
      return textResult(
        withPresentationHint(
          `Metadata for "${resolved.item.name}"\n\n${lines.join('\n')}`,
          'Render as a property list.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_update_document_metadata',
    {
      title: 'SharePoint · Act — Set a document’s metadata',
      description:
        'Set SharePoint column values on a document. Use the INTERNAL column names from ' +
        'sharepoint_list_columns as keys — display names will not work. Read-only and computed ' +
        'columns are rejected by SharePoint, and managed-metadata columns need a term object ' +
        'rather than a plain string.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selectorFields,
        fields: z
          .record(z.string(), z.unknown())
          .describe('Column internal name → value, e.g. {"DocStatus":"Approved"}.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const fields = rec(args.fields);
      if (Object.keys(fields).length === 0) return errText('No fields given.');

      const resolved = await resolveDriveItem(context, access.accessToken, selectorOf(args));
      if (!resolved.ok) return errText(resolved.error);

      const updated = await graphPatch(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}/listItem/fields`,
        fields
      );
      if (!updated.ok) return errText(updated.error);

      return textResult(
        `Updated ${Object.keys(fields).length} field(s) on "${resolved.item.name}": ` +
          `${Object.keys(fields).join(', ')}.`
      );
    }
  );
}
