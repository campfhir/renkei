/**
 * salesforce_list_apex: which Apex classes and triggers the org has, by
 * name, a page at a time, without their source.
 *
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
  APEX_LIST_DEFAULT,
  APEX_LIST_MAX,
  APEX_OBJECT,
  HIDDEN_BODY,
  apexListPage,
  apexListQuery,
  apexNameSuggestionQuery,
  apexSourceQuery,
  findInSource,
  isSoqlIdentifier,
  sourceLines,
  sourceWindow,
  triggerEvents,
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

/** One listed class or trigger, on one line. */
function listLine(kind: ApexKind, record: Record<string, unknown>): string {
  const ns = str(record.NamespacePrefix);
  const events = kind === 'trigger' ? triggerEvents(record) : [];
  const on =
    kind === 'trigger' && str(record.TableEnumOrId)
      ? ` on ${str(record.TableEnumOrId)}${events.length > 0 ? ` (${events.join(', ')})` : ''}`
      : '';
  const length =
    typeof record.LengthWithoutComments === 'number' && record.LengthWithoutComments >= 0
      ? `, ${record.LengthWithoutComments.toLocaleString('en-US')} characters`
      : '';
  const modified = str(record.LastModifiedDate).slice(0, 10);
  const by = str(rec(record.LastModifiedBy).Name);
  return (
    `- ${ns ? `${ns}.` : ''}${str(record.Name)}${on} — API ${str(record.ApiVersion)}, ` +
    `${str(record.Status)}${length}` +
    (modified ? `, last changed ${modified}${by ? ` by ${by}` : ''}` : '')
  );
}

const PLURAL: Record<ApexKind, string> = { class: 'classes', trigger: 'triggers' };

export function registerApexReadTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_list_apex',
    {
      title: 'Salesforce · Read — List Apex classes and triggers',
      description:
        'The Apex classes and triggers in the org, by name, without their source: API version, ' +
        'status, size and who last changed each; for a trigger, the object it fires on and its ' +
        'events. By default the org’s own code only (includePackages: true adds installed ' +
        'packages’). Filter with nameContains, or object for the triggers on one object. Each ' +
        'answer says how many match and, when there are more, the afterName to pass for the ' +
        'next page. Read one with salesforce_read_apex.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        kind: z
          .enum(['class', 'trigger'])
          .optional()
          .describe('Only classes or only triggers; default both.'),
        nameContains: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe('Part of the name, case-insensitive, e.g. Account.'),
        object: z
          .string()
          .optional()
          .describe('Only the triggers on this object (API name, e.g. Account or Site_Visit__c).'),
        includePackages: z
          .boolean()
          .optional()
          .describe('Also list installed packages’ code (default false: the org’s own only).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(APEX_LIST_MAX)
          .optional()
          .describe(`How many of each kind to name (default ${APEX_LIST_DEFAULT}).`),
        afterName: z
          .string()
          .min(1)
          .optional()
          .describe('The next page: names after this one, as the previous answer said.'),
      }),
    },
    async (args) => {
      if (args.object !== undefined && !isSoqlIdentifier(args.object)) {
        return errText(`"${args.object}" is not an object API name.`);
      }
      if (args.object && args.kind === 'class') {
        return errText('Classes do not fire on an object; pass kind: "trigger" with object.');
      }
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const kinds: ApexKind[] = args.kind
        ? [args.kind]
        : args.object
          ? ['trigger']
          : ['class', 'trigger'];
      const limit = args.limit ?? APEX_LIST_DEFAULT;
      const scope = args.includePackages ? '' : ' of the org’s own';
      const filters = [
        args.nameContains ? `with "${args.nameContains}" in the name` : '',
        args.object ? `on ${args.object}` : '',
        args.afterName ? `after ${args.afterName}` : '',
      ].filter(Boolean);
      const sections: string[] = [];
      for (const kind of kinds) {
        const page = await sfQueryPolicy(
          context,
          access,
          apexListQuery(kind, {
            nameContains: args.nameContains,
            object: args.object,
            includePackages: args.includePackages,
            afterName: args.afterName,
          })
        );
        if (!page.ok) return errText(`Apex ${PLURAL[kind]} could not be listed: ${page.error}`);
        const { shown, afterName } = apexListPage(page.records, limit, page.next !== null);
        const what = `Apex ${PLURAL[kind]}${scope}${filters.length > 0 ? ` ${filters.join(', ')}` : ''}`;
        if (page.totalSize === 0) {
          sections.push(`No ${what}.`);
          continue;
        }
        sections.push(
          [
            `${page.totalSize} ${what}` +
              (shown.length < page.totalSize ? ` — the first ${shown.length}:` : ':'),
            ...shown.map((record) => listLine(kind, record)),
            ...(afterName
              ? [
                  `More: call again with kind: "${kind}", afterName: "${afterName}" (and the same filters).`,
                ]
              : []),
          ].join('\n')
        );
      }
      return textResult(sections.join('\n\n'));
    }
  );

  server.registerTool(
    'salesforce_read_apex',
    {
      title: 'Salesforce · Read — Read Apex source',
      description:
        'An Apex class’s or trigger’s source by name: the whole of a small one, or a window of a ' +
        'large one (startLine/endLine). Each answer says which lines it holds of how many and ' +
        'where the next window starts. Lines are numbered for reading; the numbers are not part ' +
        'of the code — pass lineNumbers: false for the source exactly as saved, to copy or edit. ' +
        'Pass `find` to get the line numbers that mention a method, field or text, then read ' +
        'around them. Use this rather than salesforce_query for Apex source: a query returns the ' +
        'body as one string, cut short. To find a name, use salesforce_list_apex.',
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
        lineNumbers: z
          .boolean()
          .optional()
          .describe(
            'Default true: each line starts with its number. false: the source exactly as saved, nothing added.'
          ),
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

      const lineNumbers = args.lineNumbers ?? true;
      const window = sourceWindow(body, {
        startLine: args.startLine,
        endLine: args.endLine,
        lineNumbers,
      });
      if ('error' in window) return errText(`${name}: ${window.error}`);
      const whole = window.firstLine === 1 && window.lastLine === window.totalLines;
      const where = whole
        ? 'The whole source:'
        : `Lines ${window.firstLine}–${window.lastLine} of ${window.totalLines}.` +
          (window.nextStart
            ? ` The window is full: call again with startLine ${window.nextStart} for the next part.`
            : '');
      const cut = window.cutLine
        ? [
            `Line ${window.cutLine.line} is ${window.cutLine.length.toLocaleString('en-US')} characters, ` +
              'longer than one answer holds: only its start is shown, so this window is not the source exactly.',
          ]
        : [];
      // Plain source goes in a fence, so nothing around it reads as code.
      const source = lineNumbers ? window.text : `\`\`\`apex\n${window.text}\n\`\`\``;
      return textResult(
        [
          headerOf(found, window.totalLines),
          where,
          ...(lineNumbers
            ? ['(The numbers at the start of each line are not part of the code.)']
            : []),
          ...cut,
          '',
          source,
        ].join('\n')
      );
    }
  );
}
