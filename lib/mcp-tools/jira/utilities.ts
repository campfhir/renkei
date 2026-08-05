/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Utility tools for Jira MCP.
 * Miscellaneous helpful operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { analyzeTranscript, formatActionsAsMarkdown } from './transcript';
import { logger } from '@/lib/logger';

export async function registerUtilityTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // analyze_transcript
  server.registerTool(
    'analyze_transcript',
    {
      title: 'Analyze a meeting transcript for Jira actions',
      description:
        'Parses a meeting transcript and recommends MCP tool calls to implement the discussed ' +
        'actions. Detects phrasings like "create a task for X", "assign PROJ-12 to dana", or ' +
        '"move PROJ-12 to done" and suggests which tool to call with what arguments. These are ' +
        'recommendations only — no tools are executed. You must review and call them yourself.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        transcript: z.string().min(1).describe('Meeting or conversation transcript'),
        projectKey: z
          .string()
          .describe('Default project key for created issues, e.g. SCRUM')
          .optional(),
        issueKey: z
          .string()
          .describe('The issue under discussion, used to resolve "this", "it" and "that"')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] analyze_transcript invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { transcript, projectKey, issueKey } = args;

        if (!transcript || typeof transcript !== 'string') {
          return {
            content: [{ type: 'text' as const, text: 'transcript is required' }],
            isError: true,
          };
        }

        const actions = analyzeTranscript(transcript, {
          projectKey: typeof projectKey === 'string' ? projectKey : undefined,
          issueKey: typeof issueKey === 'string' ? issueKey : undefined,
        });

        logger.info('[Tool] analyze_transcript results', {
          tenantId: context.tenantId,
          accountId: context.accountId,
          actions: actions.length,
        });

        return {
          content: [{ type: 'text' as const, text: formatActionsAsMarkdown(actions) }],
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

  // connect_jira
  server.registerTool(
    'connect_jira',
    {
      title: 'Get Jira authentication URL',
      description:
        'Get the Jira authentication URL to connect your Jira workspace to this tenant. Call this if Jira is not yet connected.',
      annotations: { readOnlyHint: true },
    },
    async (_args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] connect_jira invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { db, tenantId, config } = context;

        if (!db || !config) {
          return {
            content: [{ type: 'text' as const, text: 'Database or config not available' }],
            isError: true,
          };
        }

        // Check if a Jira grant already exists for this tenant
        const existingGrant = await db
          .selectFrom('provider_grants')
          .select(['display_name', 'metadata'])
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', 'atlassian')
          .executeTakeFirst();

        if (existingGrant) {
          const metadata: Record<string, unknown> =
            typeof existingGrant.metadata === 'object' && existingGrant.metadata !== null
              ? { ...existingGrant.metadata }
              : {};
          const siteUrl =
            typeof metadata.siteUrl === 'string' ? metadata.siteUrl : 'the connected site';
          return {
            content: [
              {
                type: 'text' as const,
                text: `Jira is already connected as ${existingGrant.display_name} at ${siteUrl}`,
              },
            ],
          };
        }

        // Generate the Jira authorization URL
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: config.ATLASSIAN_CLIENT_ID,
          redirect_uri: config.ATLASSIAN_REDIRECT_URI,
          scope: config.ATLASSIAN_SCOPES,
          state: 'jira-setup',
          audience: 'api.atlassian.com',
        });

        const authUrl = `https://auth.atlassian.com/authorize?${params.toString()}`;

        const text =
          `**Jira is not connected yet.**\n\n` +
          `Please visit this URL to authenticate and connect your Jira workspace:\n\n` +
          `${authUrl}\n\n` +
          `After authentication, you'll be redirected back to complete the connection.`;

        return { content: [{ type: 'text' as const, text }] };
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
