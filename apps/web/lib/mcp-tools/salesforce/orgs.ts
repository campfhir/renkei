/**
 * salesforce_list_orgs: the organization's Salesforce connectors — one per
 * org, production and sandboxes — and which of them the person connected,
 * so a model can name the org a call should act in.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import { errText, textResult } from './client';

export function registerOrgTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'salesforce_list_orgs',
    {
      title: 'Salesforce · Read — Which Salesforce orgs?',
      description:
        'The organization’s Salesforce orgs (production and sandboxes), each its own connector, ' +
        'and which the person is connected to and as whom. Every other salesforce_ tool takes ' +
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
      if (!db) return errText('Could not read your Salesforce connections.');
      const connectors = (await listSalesforceConnectors()).filter((org) => org.enabled);
      const connections = await listSalesforceConnections(db, context.subject, connectors);
      if (connectors.length === 0)
        return textResult('Salesforce is not set up for this organization.');
      return textResult(
        connectors
          .map((org) => {
            const connection = connections.find((c) => c.connector === org.key);
            return (
              `${org.name} (org: "${org.key}") — ${org.sandbox ? 'sandbox' : 'production'}, ${org.host}: ` +
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
