/**
 * salesforce_read_apex: an Apex class's or trigger's source, a window of
 * numbered lines at a time, or the lines that mention something.
 *
 * Through salesforce_query a class body comes back as one JSON string,
 * and a tool result is cut from the front, so the middle and end of a
 * large class could not be read at all (packages/connector-salesforce/src/apex.ts).
 * Here every answer says which lines it holds out of how many and where the
 * next window starts, and `find` names line numbers to jump to.
 *
 * It runs as the person: Salesforce shows Apex source to users with
 * View Setup or Author Apex, and keeps managed-package source hidden.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  APEX_OBJECT,
  HIDDEN_BODY,
  apexNameSuggestionQuery,
  apexSourceQuery,
  findInSource,
  isSoqlIdentifier,
  sourceLines,
  sourceWindow,
  type ApexKind,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from './salesforce-auth';
import { errText, readAccess, rec, str, textResult, type SalesforceAccess } from './client';
import { sfQueryPolicy } from './policy';

type Found = { kind: ApexKind; record: Record<string, unknown> };

/** The class or trigger called `name` — the org's own when a package has one too. */
async function findApex(
  context: MCPToolContext,
  access: SalesforceAccess,
  name: string,
  kind: ApexKind | undefined
): Promise<Found | string> {
  const kinds: ApexKind[] = kind ? [kind] : ['class', 'trigger'];
  for (const candidate of kinds) {
    const page = await sfQueryPolicy(context, access, apexSourceQuery(candidate, name));
    if (!page.ok) return page.error;
    if (page.records.length === 0) continue;
    const own = page.records.find((record) => !str(record.NamespacePrefix));
    if (own) return { kind: candidate, record: own };
    if (page.records.length === 1) return { kind: candidate, record: page.records[0] };
    const namespaces = page.records.map((record) => str(record.NamespacePrefix)).join(', ');
    return `More than one installed package has an Apex ${candidate} called ${name} (${namespaces}), and the org has none of its own.`;
  }
  const suggestions: string[] = [];
  for (const candidate of kinds) {
    const page = await sfQueryPolicy(context, access, apexNameSuggestionQuery(candidate, name));
    if (!page.ok) continue;
    for (const record of page.records) {
      const ns = str(record.NamespacePrefix);
      suggestions.push(`${ns ? `${ns}.` : ''}${str(record.Name)} (${candidate})`);
    }
  }
  const what = kind ? `Apex ${kind}` : 'Apex class or trigger';
  return suggestions.length > 0
    ? `No ${what} is called ${name}. Names that contain it: ${suggestions.join(', ')}.`
    : `No ${what} is called ${name}, and none has it in its name.`;
}

function headerOf(found: Found, totalLines: number): string {
  const { record, kind } = found;
  const ns = str(record.NamespacePrefix);
  const on =
    kind === 'trigger' && str(record.TableEnumOrId) ? ` on ${str(record.TableEnumOrId)}` : '';
  const modified = str(record.LastModifiedDate).slice(0, 10);
  const by = str(rec(record.LastModifiedBy).Name);
  return (
    `${APEX_OBJECT[kind]} ${ns ? `${ns}.` : ''}${str(record.Name)}${on} — ` +
    `API ${str(record.ApiVersion)}, ${str(record.Status)}, ${totalLines} lines` +
    (modified ? `, last changed ${modified}${by ? ` by ${by}` : ''}` : '') +
    ` (id ${str(record.Id)})`
  );
}

export function registerApexReadTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_read_apex',
    {
      title: 'Salesforce · Read — Read Apex source',
      description:
        'An Apex class’s or trigger’s source by name, as numbered lines: the whole of a small ' +
        'one, or a window of a large one (startLine/endLine). Each answer says which lines it ' +
        'holds of how many and where the next window starts. Pass `find` to get the line numbers ' +
        'that mention a method, field or text, then read around them. Use this rather than ' +
        'salesforce_query for Apex source: a query returns the body as one string, cut short.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        name: z.string().min(1).describe('The class or trigger name, e.g. AccountService.'),
        kind: z
          .enum(['class', 'trigger'])
          .optional()
          .describe('Which it is; default looks for a class, then a trigger.'),
        startLine: z.number().int().min(1).optional().describe('First line to read (default 1).'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Last line to read (default the end; a window stops sooner when it is full).'),
        find: z
          .string()
          .min(2)
          .max(200)
          .optional()
          .describe(
            'Instead of reading lines: the line numbers that contain this text (case-insensitive).'
          ),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const name = args.name.trim().replace(/\.(cls|trigger)$/i, '');
      if (!isSoqlIdentifier(name)) {
        return errText(`"${args.name}" is not an Apex name (letters, digits and underscores).`);
      }
      const found = await findApex(context, access, name, args.kind);
      if (typeof found === 'string') return errText(found);
      const body = str(found.record.Body);
      if (body === HIDDEN_BODY) {
        return errText(
          `${name} is part of the installed package ${str(found.record.NamespacePrefix)}, whose source Salesforce does not show.`
        );
      }

      if (args.find) {
        const totalLines = sourceLines(body).length;
        const { hits, total } = findInSource(body, args.find);
        if (total === 0) {
          return textResult(`${headerOf(found, totalLines)}\nNo line contains "${args.find}".`);
        }
        return textResult(
          [
            headerOf(found, totalLines),
            `${total} line${total === 1 ? '' : 's'} contain "${args.find}"` +
              (total > hits.length ? ` (the first ${hits.length} shown)` : '') +
              ' — read around one with startLine/endLine:',
            ...hits.map((hit) => `${hit.line}: ${hit.text}`),
          ].join('\n')
        );
      }

      const window = sourceWindow(body, { startLine: args.startLine, endLine: args.endLine });
      if ('error' in window) return errText(`${name}: ${window.error}`);
      const whole = window.firstLine === 1 && window.lastLine === window.totalLines;
      const where = whole
        ? 'The whole source:'
        : `Lines ${window.firstLine}–${window.lastLine} of ${window.totalLines}.` +
          (window.nextStart
            ? ` The window is full: call again with startLine ${window.nextStart} for the next part.`
            : '');
      return textResult([headerOf(found, window.totalLines), where, '', window.text].join('\n'));
    }
  );
}
