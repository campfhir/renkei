/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Customer management tools for JSM.
 * Handle customer lifecycle in service desks.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { resolveAccountId } from '../user-resolver';
import { logger } from '@/lib/logger';

export async function registerJsmCustomerTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // create_customer
  server.registerTool(
    'create_customer',
    {
      title: 'Create a new customer',
      description: 'Create a new customer in Jira Service Management.',
      inputSchema: z.object({
        email: z.string().describe('Customer email address'),
        displayName: z.string().describe('Customer display name (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      // Named distinctly: this handler also destructures a `displayName` from
      // args, which is the *customer's* name, not the caller's.
      const invokerDisplayName = getCachedDisplayName(context.accountId);
      logger.info('create_customer invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName: invokerDisplayName,
      });
      try {
        const { email, displayName } = args;

        if (!email) {
          return { content: [{ type: 'text' as const, text: 'email is required' }], isError: true };
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/customer`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              email,
              displayName: displayName || (email as string).split('@')[0],
            }),
          }
        );

        const customer = (await response.json()) as any;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created customer ${customer.displayName} (${customer.emailAddress})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // add_customer_to_servicedesk
  server.registerTool(
    'add_customer_to_servicedesk',
    {
      title: 'Add customers to a service desk',
      description:
        'Add an existing customer to a service desk, by email address or Atlassian account ID. ' +
        'Use invite_customers_to_servicedesk instead for someone who does not have an account yet.',
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        user: z
          .string()
          .describe('Email address, or an Atlassian accountId such as "5b10a2844c20165700ede21g"'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('add_customer_to_servicedesk invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { serviceDeskId, user } = args;

        if (!serviceDeskId || !user) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId and user are required' }],
            isError: true,
          };
        }

        // This endpoint takes account IDs only, so an email has to be resolved
        // first. It previously passed the email straight through as an
        // accountId, which Atlassian rejects.
        const accountId = await resolveAccountId(context, user);

        await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: [accountId],
            }),
          }
        );

        return {
          content: [
            { type: 'text' as const, text: `Added ${accountId} to service desk ${serviceDeskId}` },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // remove_customer_from_servicedesk
  server.registerTool(
    'remove_customer_from_servicedesk',
    {
      title: 'Remove customers from a service desk',
      description:
        'Remove a customer from a service desk, by email address or Atlassian account ID.',
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        user: z
          .string()
          .describe('Email address, or an Atlassian accountId such as "5b10a2844c20165700ede21g"'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('remove_customer_from_servicedesk invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { serviceDeskId, user } = args;

        if (!serviceDeskId || !user) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId and user are required' }],
            isError: true,
          };
        }

        const accountId = await resolveAccountId(context, user);

        // Account ids go in the body; this endpoint accepts no query parameters.
        await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          context.accessToken,
          {
            method: 'DELETE',
            body: JSON.stringify({ accountIds: [accountId] }),
          }
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `Removed ${accountId} from service desk ${serviceDeskId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // invite_customers_to_servicedesk
  server.registerTool(
    'invite_customers_to_servicedesk',
    {
      title: 'Invite email addresses to a service desk',
      description: 'Invite customers to a service desk.',
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        emails: z.array(z.string()).describe('Customer emails to invite'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('invite_customers_to_servicedesk invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { serviceDeskId, emails } = args;

        if (!serviceDeskId || !emails || !Array.isArray(emails)) {
          return {
            content: [
              { type: 'text' as const, text: 'serviceDeskId and emails array are required' },
            ],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: emails,
            }),
          }
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `Invited ${emails.length} customers to service desk ${serviceDeskId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );
}
