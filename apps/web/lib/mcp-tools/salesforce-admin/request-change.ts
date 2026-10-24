/**
 * The way in for someone who may ask for a change to a Salesforce org but
 * not approve one: a request in words. The propose tools read the live
 * metadata and have Salesforce validate the exact package, which needs the
 * person's own Salesforce rights to the org's setup; an ordinary user has
 * none of those, and applying is an operator's click in any case. So a
 * non-operator describes what they want and why (with the read tools to
 * look up the objects and fields they mean), and an operator is told: they
 * build it as a proposal (passing this request's id as `replaces`) or
 * decline it with a reason.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText } from '../salesforce/client';
import { fileRequest, reasonField, refusesChanges } from './shared';

export function registerAdminRequestTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_request_change',
    {
      title: 'Salesforce Admin · Act — Ask an operator for a change',
      description:
        'Ask for a change to a Salesforce org’s setup — a new field, a picklist value, a ' +
        'layout change, access for a team — in words, when you cannot approve changes yourself. ' +
        'Nothing changes in Salesforce: operators are told, and one builds it as a proposal that ' +
        'Salesforce validates, or declines it with a reason. Look up the exact object and field ' +
        'names first (salesforce_admin_describe_object) and say what the change is for, so the ' +
        'operator does not have to ask. Returns a link to follow the request.',
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
            'What should change, in detail: the object, the field names and types, the values, ' +
              'who needs access. Exact API names where you know them.'
          ),
        reason: reasonField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      return fileRequest(context, access, {
        title: args.title,
        description: args.description,
        reason: args.reason,
      });
    }
  );
}
