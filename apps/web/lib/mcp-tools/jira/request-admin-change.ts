/**
 * Asking for a change to Jira's configuration, from the everyday Jira
 * connector.
 *
 * Anyone who uses Jira through Renkei may ask for a change to how it is set
 * up, in words; approving is a different job — an operator with a Jira
 * Administration connection to the same site, in their browser — so a
 * request needs no admin connection of its own. The request records the
 * site it was made on, and approving refuses to run it anywhere else.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import { CHANGE_REQUEST_TTL_HOURS, createRequest } from '@/lib/jira-admin/change-requests';
import { reviewPrefix } from '../jira-admin/review-link';

function textError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** The site's cloud id: the context's own, else the one in the API gateway address. */
function cloudIdOf(context: MCPToolContext): string {
  if (context.cloudId) return context.cloudId;
  const match = /\/ex\/jira\/([^/]+)/.exec(context.apiBaseUrl ?? '');
  return match?.[1] ?? '';
}

export function registerRequestAdminChangeTool(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'jira_request_admin_change',
    {
      title: 'Jira · Act — Ask an admin for a change to Jira’s configuration',
      description:
        'Ask for a change to how Jira is set up — a field option, a new space, a screen ' +
        'change, an automation rule — in words. You do not need to be an admin: operators who ' +
        'administer Jira are told, and one builds it as a proposal and approves it, or ' +
        'declines it with a reason. Nothing changes in Jira from this call. Look up the ' +
        'exact names first and say what the change is for, so the admin does not have to ask. ' +
        'Returns a link to follow the request.',
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
      if (!context.subject) return textError('No signed-in subject on this MCP session.');
      const cloudId = cloudIdOf(context);
      if (!context.jiraAuth || !cloudId) {
        return textError('Jira is not connected. Connect it on the Connectors page.');
      }
      const request = await createRequest({
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId,
        siteUrl: context.siteUrl || undefined,
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
