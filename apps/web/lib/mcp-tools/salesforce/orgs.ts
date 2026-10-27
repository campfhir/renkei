/**
 * salesforce_list_orgs (and salesforce_admin_list_orgs): the organization's
 * connectors of a type — one per org, production and sandboxes — and which
 * of them the person connected, so a model can name the org a call should
 * act in.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import type { SalesforceOrg } from '@renkei/connector-salesforce';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import { SALESFORCE_CRM_KIND, type SalesforceKind } from '@/lib/salesforce-kinds';
import { errText, textResult } from './client';

export function registerOrgTools(
  server: McpServer,
  context: MCPToolContext,
  kind: SalesforceKind = SALESFORCE_CRM_KIND,
  options: { name: string; prefix: string; describe?: (org: SalesforceOrg) => string } = {
    name: 'salesforce_list_orgs',
    prefix: 'salesforce_',
  }
): void {
  server.registerTool(
    options.name,
    {
      title: `${kind.label} · Read — Which Salesforce orgs?`,
      description:
        `The organization’s ${kind.label} orgs (production and sandboxes), each its own connector, ` +
        `and which the person is connected to and as whom. Every other ${options.prefix} tool takes ` +
        '`org` to say which one it acts in.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!context.subject) return errText('No signed-in identity on this request.');
      const db =
        context.db ??
        (() => {
          const result = getDatabase();
          return result.ok ? result.val : null;
        })();
      if (!db) return errText(`Could not read your ${kind.label} connections.`);
      const connectors = (await listSalesforceConnectors(kind)).filter((org) => org.enabled);
      const connections = await listSalesforceConnections(
        context.subject,
        connectors,
        kind.provider
      );
      if (connectors.length === 0)
        return textResult(`${kind.label} is not set up for this organization.`);
      return textResult(
        connectors
          .map((org) => {
            const connection = connections.find((c) => c.connector === org.key);
            return (
              `${org.name} (org: "${org.key}") — ${org.sandbox ? 'sandbox' : 'production'}, ${org.host}` +
              (options.describe ? `, ${options.describe(org)}` : '') +
              ': ' +
              (connection
                ? `connected as ${connection.displayName}${connection.username ? ` (${connection.username})` : ''}; may ${connection.requestedScopes.join(', ') || 'nothing'}`
                : 'not connected')
            );
          })
          .join('\n')
      );
    }
  );
}
