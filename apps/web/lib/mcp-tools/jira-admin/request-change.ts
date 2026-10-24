/**
 * The way in for someone who may ask for a change to Jira but not approve
 * one: a request in words. The propose tools read the live configuration
 * and store the exact operations, which needs the person's own Jira admin
 * rights; an ordinary user has none, and applying is an operator's click in
 * any case. So a non-operator describes what they want and why (with the
 * read tools to look up the field or space they mean), and an operator is
 * told: they build it as a proposal (passing this request's id as
 * `replaces`) or decline it with a reason.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText } from './client';
import { CHANGE_REQUEST_TTL_HOURS, createRequest } from '@/lib/jira-admin/change-requests';
import { reviewPrefix } from './review-link';

export function registerRequestTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): void {
  server.registerTool(
    'jira_admin_request_change',
    {
      title: 'Jira Admin · Act — Ask an operator for a change',
      description:
        'Ask for a change to Jira’s configuration — a field option, a new space, a screen ' +
        'change, an automation rule — in words, when you cannot approve changes yourself. ' +
        'Nothing changes in Jira: operators are told, and one builds it as a proposal, or ' +
        'declines it with a reason. Look up the exact names first (jira_admin_list_fields, ' +
        'jira_admin_get_field, jira_admin_get_space_configuration) and say what the change is ' +
        'for, so the operator does not have to ask. Returns a link to follow the request.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(200)
          .describe('One line: “Add a Vendor option to the Source field in OPS”.'),
        description: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            'What should change, in detail: the field or space (keys and names exactly), the ' +
              'values, who needs access.'
          ),
        reason: z.string().max(2000).optional().describe('Why, in the person’s words.'),
      }),
    },
    async (args) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was requested.');
      const request = await createRequest(dbResult.val, {
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        title: args.title,
        reason: args.reason,
        description: args.description,
      });
      const link = `${reviewPrefix(context)}${request.id}`;
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              'Requested — nothing has changed in Jira.',
              'Operators have been told. One of them will build it as a proposal and approve it, or decline it with a reason.',
              '',
              `Follow it here: ${link}`,
              `Request ${request.id}; it expires in ${CHANGE_REQUEST_TTL_HOURS} hours if nobody picks it up.`,
            ].join('\n'),
          },
        ],
        _meta: actMeta({ url: link }),
      };
    }
  );
}
