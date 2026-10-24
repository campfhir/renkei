/**
 * Asking for a change to the org's setup, from the CRM connector.
 *
 * Whoever uses Salesforce through Renkei (the CRM connector) may ask for a
 * change to its setup in words; approving is a different job — an operator
 * with a Salesforce Admin connection to the org, in their browser — so a
 * request needs no admin connection of its own. The CRM org the person is
 * connected to is matched to the org's Salesforce Admin connector (same My
 * Domain) so the request lands where an operator can approve it; an org
 * with no admin connector, or one that takes no changes, refuses the
 * request here, since nobody could ever approve it.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from './salesforce-auth';
import { errText } from './client';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import {
  fileRequest,
  reasonField,
  refusesChanges,
} from '../salesforce-admin/shared';

export function registerRequestAdminChangeTool(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_request_admin_change',
    {
      title: 'Salesforce · Act — Ask an admin for a change to the org’s setup',
      description:
        'Ask for a change to how this Salesforce org is set up — a new field, a picklist ' +
        'value, a layout change, access for a team — in words. You do not need to be an ' +
        'admin: operators who administer the org are told, and one builds it as a proposal ' +
        'that Salesforce validates and approves it, or declines it with a reason. Nothing ' +
        'changes in Salesforce from this call. Look up the exact object and field names ' +
        'first (salesforce_describe_object) and say what the change is for. Returns a link ' +
        'to follow the request.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(200)
          .describe('One line: “Add an Outcome picklist to Site Visit”.'),
        description: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            'What should change, in detail: the object, the field names and types, the ' +
              'values, who needs access. Exact API names where you know them.'
          ),
        reason: reasonField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const host = (origin: string) => origin.replace(/^https?:\/\//i, '').toLowerCase();
      const admin = (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).find(
        (org) => org.enabled && host(org.myDomain) === host(access.instanceUrl)
      );
      if (!admin) {
        return errText(
          `${access.connectorName} has no Salesforce Admin connector set up, so a change to it ` +
            'could not be approved. Ask your Renkei administrator to add one.'
        );
      }
      const refused = await refusesChanges({ connector: admin.key });
      if (refused) return errText(refused);
      return fileRequest(
        context,
        {
          connector: admin.key,
          connectorName: admin.name,
          orgId: access.orgId,
          instanceUrl: admin.myDomain,
          sandbox: admin.sandbox,
        },
        { title: args.title, description: args.description, reason: args.reason }
      );
    }
  );
}
