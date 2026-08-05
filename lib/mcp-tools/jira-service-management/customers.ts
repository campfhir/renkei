/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Customer management tools for JSM.
 * Handle customer lifecycle in service desks.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MCPToolContext } from '../common';
import { jiraFetch } from '../common';

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
      try {
        const { email, displayName } = args;

        if (!email) {
          return { content: [{ type: 'text' as const, text: 'email is required' }], isError: true };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/customer`,
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
      description: 'Add a customer to a service desk.',
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        email: z.string().describe('Customer email address'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { serviceDeskId, email } = args;

        if (!serviceDeskId || !email) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId and email are required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: [email],
            }),
          }
        );

        return {
          content: [
            { type: 'text' as const, text: `Added ${email} to service desk ${serviceDeskId}` },
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
      description: 'Remove a customer from a service desk.',
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        email: z.string().describe('Customer email address'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { serviceDeskId, email } = args;

        if (!serviceDeskId || !email) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId and email are required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer?accountId=${encodeURIComponent(email as string)}`,
          context.accessToken,
          {
            method: 'DELETE',
          }
        );

        return {
          content: [
            { type: 'text' as const, text: `Removed ${email} from service desk ${serviceDeskId}` },
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
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
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
