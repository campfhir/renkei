/**
 * The fabric_ reads: what the connection holds, the workspaces a person
 * has a role in, what is in one, a lakehouse's tables, and the capacities
 * a new workspace could go on. Live calls as the person; nothing indexed.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { FABRIC_SCOPE_OPTIONS, shortFabricScope } from '@/lib/fabric-scopes';
import type { FabricAuth } from './fabric-auth';
import { errText, fabricList, portalLink, str, textResult } from './client';
import { itemOf, resolveItem, resolveWorkspace, workspaceOf } from './resolve';

export const workspaceField = z
  .string()
  .min(1)
  .describe('The workspace: its id, or its name exactly as Fabric shows it.');

const ITEM_TYPES = [
  'Notebook',
  'DataPipeline',
  'Lakehouse',
  'Warehouse',
  'SemanticModel',
  'Report',
  'Dataflow',
  'Environment',
  'SparkJobDefinition',
  'KQLDatabase',
  'Eventstream',
] as const;

export async function registerReadTools(
  server: McpServer,
  context: MCPToolContext,
  auth: FabricAuth
): Promise<void> {
  server.registerTool(
    'fabric_check_access',
    {
      title: 'Fabric · Check access',
      description:
        'Say which Fabric account is connected and what the connection lets Renkei do — ' +
        'browse workspaces and tables, create and change workspaces, notebooks and pipelines. ' +
        'Call this first when a Fabric tool is missing or Fabric answers 403.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const held = new Set(context.fabricScopes ?? []);
      const lines = FABRIC_SCOPE_OPTIONS.map((option) => {
        const has = option.scopes.map(shortFabricScope).every((scope) => held.has(scope));
        return `${has ? '✓' : '✗'} ${option.label}`;
      });
      return textResult(
        [
          `Connected to Microsoft Fabric as ${access.upn || 'an unnamed account'}.`,
          ...lines,
          'Fabric also applies your role in each workspace (Viewer, Contributor, Member, Admin) ' +
            'on every call: creating and changing items needs Contributor or above, changing a ' +
            'workspace needs Admin. A ✗ is added by reconnecting on the Connectors page, within ' +
            'what your organization allows.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'fabric_list_workspaces',
    {
      title: 'Fabric · List workspaces',
      description:
        'The Fabric workspaces you have a role in, with their ids and capacities. `search` ' +
        'narrows by a part of the name.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z.string().optional().describe('Part of a workspace name, any case.'),
      }),
    },
    async ({ search }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const listed = await fabricList(context, access, '/workspaces');
      if (!listed.ok) return errText(`Could not list workspaces: ${listed.error}`);
      const needle = search?.trim().toLowerCase() ?? '';
      const workspaces = listed.values
        .map(workspaceOf)
        .filter((w) => !needle || w.displayName.toLowerCase().includes(needle))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      if (workspaces.length === 0) {
        return textResult(
          needle
            ? `No workspace you can see matches "${search}".`
            : 'You have no Fabric workspaces.'
        );
      }
      return textResult(
        [
          `${workspaces.length} workspace(s)${listed.truncated ? ' (more exist; narrow with search)' : ''}:`,
          ...workspaces.map(
            (w) =>
              `- ${w.displayName} — id ${w.id}${w.type === 'Personal' ? ' (My workspace)' : ''}` +
              (w.capacityId ? `, capacity ${w.capacityId}` : ', no capacity')
          ),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'fabric_get_workspace',
    {
      title: 'Fabric · Get a workspace',
      description:
        'One workspace: its description and capacity, and how many of each kind of item it ' +
        'holds (notebooks, data pipelines, lakehouses…), with a link to it in Fabric.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceField }),
    },
    async ({ workspace: ref }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const workspace = await resolveWorkspace(context, access, ref);
      if (typeof workspace === 'string') return errText(workspace);
      const items = await fabricList(context, access, `/workspaces/${workspace.id}/items`);
      const counts = new Map<string, number>();
      if (items.ok)
        for (const raw of items.values)
          counts.set(str(raw.type), (counts.get(str(raw.type)) ?? 0) + 1);
      return textResult(
        [
          `Workspace "${workspace.displayName}" — id ${workspace.id}`,
          workspace.description ? `Description: ${workspace.description}` : 'No description.',
          workspace.capacityId ? `Capacity: ${workspace.capacityId}` : 'No capacity assigned.',
          items.ok
            ? counts.size
              ? `Items: ${[...counts.entries()]
                  .sort()
                  .map(([type, n]) => `${n} ${type}`)
                  .join(', ')}`
              : 'Items: none.'
            : `Items could not be listed: ${items.error}`,
          `Open in Fabric: ${portalLink(workspace.id)}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'fabric_list_items',
    {
      title: 'Fabric · List items in a workspace',
      description:
        'The items in a workspace — notebooks, data pipelines, lakehouses, warehouses, ' +
        'reports and the rest — with their ids. `type` keeps one kind.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceField,
        type: z.enum(ITEM_TYPES).optional().describe('Only items of this kind.'),
      }),
    },
    async ({ workspace: ref, type }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const workspace = await resolveWorkspace(context, access, ref);
      if (typeof workspace === 'string') return errText(workspace);
      const listed = await fabricList(
        context,
        access,
        `/workspaces/${workspace.id}/items${type ? `?type=${type}` : ''}`
      );
      if (!listed.ok) return errText(`Could not list items: ${listed.error}`);
      const items = listed.values
        .map(itemOf)
        .sort((a, b) => a.type.localeCompare(b.type) || a.displayName.localeCompare(b.displayName));
      if (items.length === 0) {
        return textResult(`"${workspace.displayName}" has no ${type ? `${type} ` : ''}items.`);
      }
      return textResult(
        [
          `${items.length} item(s) in "${workspace.displayName}":`,
          ...items.map(
            (item) =>
              `- ${item.displayName} (${item.type}) — id ${item.id}` +
              (item.description ? ` — ${item.description}` : '')
          ),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'fabric_list_tables',
    {
      title: 'Fabric · List lakehouse tables',
      description:
        'The tables in a lakehouse: name, managed or external, format (Delta, …) and OneLake ' +
        'location. Names and shapes only — no rows are read.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceField,
        lakehouse: z.string().min(1).describe('The lakehouse: its id or exact name.'),
      }),
    },
    async ({ workspace: ref, lakehouse: lakehouseRef }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const workspace = await resolveWorkspace(context, access, ref);
      if (typeof workspace === 'string') return errText(workspace);
      const lakehouse = await resolveItem(context, access, workspace, 'Lakehouse', lakehouseRef);
      if (typeof lakehouse === 'string') return errText(lakehouse);
      const listed = await fabricList(
        context,
        access,
        `/workspaces/${workspace.id}/lakehouses/${lakehouse.id}/tables?maxResults=100`
      );
      if (!listed.ok) {
        // Fabric does not list a schema-enabled lakehouse's tables this way.
        return errText(`Could not list the tables of "${lakehouse.displayName}": ${listed.error}`);
      }
      if (listed.values.length === 0)
        return textResult(`"${lakehouse.displayName}" has no tables.`);
      return textResult(
        [
          `${listed.values.length} table(s) in "${lakehouse.displayName}"${listed.truncated ? ' (more exist)' : ''}:`,
          ...listed.values.map(
            (table) =>
              `- ${str(table.name)} — ${str(table.type) || 'table'}, ${str(table.format) || 'unknown format'}` +
              (str(table.location) ? ` — ${str(table.location)}` : '')
          ),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'fabric_list_capacities',
    {
      title: 'Fabric · List capacities',
      description:
        'The Fabric capacities you may put a workspace on — name, id, SKU, region and state — ' +
        'for fabric_create_workspace_preview.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const listed = await fabricList(context, access, '/capacities');
      if (!listed.ok) return errText(`Could not list capacities: ${listed.error}`);
      if (listed.values.length === 0)
        return textResult('No capacity you may assign workspaces to.');
      return textResult(
        [
          `${listed.values.length} capacity(ies):`,
          ...listed.values.map(
            (c) =>
              `- ${str(c.displayName)} — id ${str(c.id)}, ${str(c.sku)}, ${str(c.region)}, ${str(c.state)}`
          ),
        ].join('\n')
      );
    }
  );
}
