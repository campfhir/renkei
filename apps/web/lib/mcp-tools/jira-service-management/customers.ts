/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Customer management tools for JSM.
 * Handle customer lifecycle in service desks.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { resolveAccountId } from '../user-resolver';
import { logger } from '@/lib/logger';
import { customerScopes, describeJsmAuthFailure, type JsmAuth } from './jsm-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

/**
 * An accountId for a customer email: create the customer (Jira returns the
 * account whether new or, on some sites, existing), falling back to user
 * search for accounts the create endpoint refuses. Null = unresolvable, and
 * the caller reports it instead of sending an email where an accountId goes.
 *
 * No explicit response.ok check on either call here (unlike every other
 * handler in this file): both already validate the SHAPE of what they parsed
 * (`body?.accountId`, `Array.isArray(users)`), so a denied auth.fetch() —
 * whose body is `{message}`, matching neither shape — already falls through
 * to the next attempt, or to null, exactly as a real 403 falling into the
 * catch block always did. Surfacing the auth denial's reason specifically
 * would require this function to stop being "resolve or give up quietly",
 * which its one caller relies on (it reports UNRESOLVED emails, not why).
 */
async function resolveCustomerAccountId(
  context: MCPToolContext,
  auth: JsmAuth,
  email: string
): Promise<string | null> {
  try {
    const created = await auth.fetch(
      customerScopes('jsm_invite_customers_to_servicedesk', false),
      '/rest/servicedeskapi/customer',
      {
        method: 'POST',
        body: JSON.stringify({ email, displayName: email.split('@')[0] }),
        headers: { 'X-ExperimentalApi': 'opt-in' },
      }
    );
    const body = (await created.json()) as any;
    if (typeof body?.accountId === 'string' && body.accountId) return body.accountId;
  } catch {
    // exists already, or creation refused — try the directory
  }
  try {
    const found = await auth.fetch(
      customerScopes('jsm_invite_customers_to_servicedesk', false),
      `/rest/api/3/user/search?query=${encodeURIComponent(email)}`
    );
    const users = (await found.json()) as any;
    if (Array.isArray(users)) {
      const exact = users.find(
        (u: any) =>
          typeof u?.emailAddress === 'string' &&
          u.emailAddress.toLowerCase() === email.toLowerCase()
      );
      const pick = exact ?? (users.length === 1 ? users[0] : null);
      if (pick && typeof pick.accountId === 'string') return pick.accountId;
    }
  } catch {
    // fall through to null
  }
  return null;
}

export async function registerJsmCustomerTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JsmAuth
): Promise<void> {
  // jsm_create_customer
  server.registerTool(
    'jsm_create_customer',
    {
      title: 'JSM · Act — Create a new customer',
      description: 'Create a new customer in Jira Service Management.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        email: z.string().describe('Customer email address'),
        displayName: z.string().describe('Customer display name (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      // Named distinctly: this handler also destructures a `displayName` from
      // args, which is the *customer's* name, not the caller's.
      const invokerDisplayName = getCachedDisplayName(context.accountId);
      logger.debug('jsm_create_customer invoked', {
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

        const response = await auth.fetch(
          customerScopes('jsm_create_customer', false),
          '/rest/servicedeskapi/customer',
          {
            method: 'POST',
            body: JSON.stringify({
              email,
              displayName: displayName || (email as string).split('@')[0],
            }),
            headers: { 'X-ExperimentalApi': 'opt-in' },
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

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

  // jsm_add_customer_to_servicedesk
  server.registerTool(
    'jsm_add_customer_to_servicedesk',
    {
      title: 'JSM · Act — Add customers to a service desk',
      description:
        'Add an existing customer to a service desk, by email address or Atlassian account ID. ' +
        'Use jsm_invite_customers_to_servicedesk instead for someone who does not have an account yet.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        user: z
          .string()
          .describe('Email address, or an Atlassian accountId such as "5b10a2844c20165700ede21g"'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jsm_add_customer_to_servicedesk invoked', {
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

        const response = await auth.fetch(
          customerScopes('jsm_add_customer_to_servicedesk', false),
          `/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: [accountId],
            }),
            headers: { 'X-ExperimentalApi': 'opt-in' },
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

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

  // jsm_remove_customer_from_servicedesk
  server.registerTool(
    'jsm_remove_customer_from_servicedesk',
    {
      title: 'JSM · Act — Remove customers from a service desk',
      description:
        'Remove a customer from a service desk, by email address or Atlassian account ID.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        user: z
          .string()
          .describe('Email address, or an Atlassian accountId such as "5b10a2844c20165700ede21g"'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jsm_remove_customer_from_servicedesk invoked', {
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
        const response = await auth.fetch(
          customerScopes('jsm_remove_customer_from_servicedesk', false),
          `/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          {
            method: 'DELETE',
            body: JSON.stringify({ accountIds: [accountId] }),
            headers: { 'X-ExperimentalApi': 'opt-in' },
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

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

  // jsm_invite_customers_to_servicedesk
  server.registerTool(
    'jsm_invite_customers_to_servicedesk',
    {
      title: 'JSM · Act — Invite email addresses to a service desk',
      description: 'Invite customers to a service desk.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        emails: z.array(z.string()).describe('Customer emails to invite'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jsm_invite_customers_to_servicedesk invoked', {
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

        // ServiceDeskCustomerDTO takes accountIds — emails are not account
        // ids, so each email resolves first: create the customer (returns the
        // account) or fall back to user search for existing accounts.
        const resolved: string[] = [];
        const unresolved: string[] = [];
        for (const email of emails as string[]) {
          const accountId = await resolveCustomerAccountId(context, auth, email);
          if (accountId) resolved.push(accountId);
          else unresolved.push(email);
        }
        if (resolved.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No accounts could be resolved for: ${unresolved.join(', ')}`,
              },
            ],
            isError: true,
          };
        }
        const response = await auth.fetch(
          customerScopes('jsm_invite_customers_to_servicedesk', false),
          `/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`,
          {
            method: 'POST',
            body: JSON.stringify({ accountIds: resolved }),
            headers: { 'X-ExperimentalApi': 'opt-in' },
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Invited ${resolved.length} customer(s) to service desk ${serviceDeskId}` +
                (unresolved.length ? ` — could not resolve: ${unresolved.join(', ')}` : ''),
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
