/**
 * Customer management tools for JSM.
 * Handle customer lifecycle in service desks.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, toolError, jiraFetch } from '../common';

export interface CustomerToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const customerTools: CustomerToolHandler[] = [
  {
    name: 'create_customer',
    description: 'Create a new customer in Jira Service Management.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Customer email address',
        },
        displayName: {
          type: 'string',
          description: 'Customer display name (optional)',
        },
      },
      required: ['email'],
    },
    handler: async (context, params) => {
      const { email, displayName } = params;

      if (!email) {
        return toolError('email is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/customer`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              email,
              displayName: displayName || email.split('@')[0],
            }),
          },
        );

        const customer = (await response.json()) as any;
        return ok(`Created customer ${customer.displayName} (${customer.emailAddress})`);
      } catch (error) {
        return toolError(`Failed to create customer: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'add_customer_to_servicedesk',
    description: 'Add a customer to a service desk.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: {
          type: 'string',
          description: 'Service desk ID',
        },
        email: {
          type: 'string',
          description: 'Customer email address',
        },
      },
      required: ['serviceDeskId', 'email'],
    },
    handler: async (context, params) => {
      const { serviceDeskId, email } = params;

      if (!serviceDeskId || !email) {
        return toolError('serviceDeskId and email are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: [email],
            }),
          },
        );

        return ok(`Added ${email} to service desk ${serviceDeskId}`);
      } catch (error) {
        return toolError(`Failed to add customer: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'remove_customer_from_servicedesk',
    description: 'Remove a customer from a service desk.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: {
          type: 'string',
          description: 'Service desk ID',
        },
        email: {
          type: 'string',
          description: 'Customer email address',
        },
      },
      required: ['serviceDeskId', 'email'],
    },
    handler: async (context, params) => {
      const { serviceDeskId, email } = params;

      if (!serviceDeskId || !email) {
        return toolError('serviceDeskId and email are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer?accountId=${encodeURIComponent(email)}`,
          context.accessToken,
          {
            method: 'DELETE',
          },
        );

        return ok(`Removed ${email} from service desk ${serviceDeskId}`);
      } catch (error) {
        return toolError(`Failed to remove customer: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'invite_customers_to_servicedesk',
    description: 'Invite customers to a service desk.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: {
          type: 'string',
          description: 'Service desk ID',
        },
        emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Customer emails to invite',
        },
      },
      required: ['serviceDeskId', 'emails'],
    },
    handler: async (context, params) => {
      const { serviceDeskId, emails } = params;

      if (!serviceDeskId || !emails || !Array.isArray(emails)) {
        return toolError('serviceDeskId and emails array are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: emails,
            }),
          },
        );

        return ok(`Invited ${emails.length} customers to service desk ${serviceDeskId}`);
      } catch (error) {
        return toolError(`Failed to invite customers: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
