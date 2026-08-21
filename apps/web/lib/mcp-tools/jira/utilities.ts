/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Utility tools for Jira MCP.
 * Miscellaneous helpful operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import {
  analyzeTranscript,
  formatActionsAsMarkdown,
  MEETING_TYPES,
  isMeetingType,
} from './transcript';
import { logger } from '@/lib/logger';

export async function registerUtilityTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // analyze_transcript
  server.registerTool(
    'analyze_transcript',
    {
      title: 'Jira · Read — Analyze a meeting transcript for Jira actions',
      description:
        'Parses a meeting transcript and recommends MCP tool calls to implement the discussed ' +
        'actions. Detects phrasings like "create a task for X", "assign PROJ-12 to dana", ' +
        '"move PROJ-12 to done", "blocked on the vendor", "spent 2h on PROJ-12" and "pull ' +
        'PROJ-12 into the sprint". Identifies whether the meeting was a standup, sprint ' +
        'planning, a retro or ad-hoc, and weighs each recommendation by how well it fits. ' +
        'Story points and original estimates are recommended as jira_update_issue calls, which ' +
        'resolve the field by name against the site. These are recommendations only: no tools ' +
        'are executed. You must review and call them yourself.',
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
        meetingType: z
          .enum(MEETING_TYPES)
          .describe(
            'The kind of meeting. Inferred from the transcript when omitted; supplying it ' +
              'avoids a misread, since the type shifts how confident each recommendation is.'
          )
          .optional(),
        durationMinutes: z
          .number()
          .describe('Meeting length, used only to break a tie when the wording is ambiguous')
          .optional(),
        sprintId: z
          .string()
          .describe('Target sprint, so "pull it into the sprint" becomes a complete call')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('analyze_transcript invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { transcript, projectKey, issueKey, meetingType, durationMinutes, sprintId } = args;

        if (!transcript || typeof transcript !== 'string') {
          return {
            content: [{ type: 'text' as const, text: 'transcript is required' }],
            isError: true,
          };
        }

        const analysis = analyzeTranscript(transcript, {
          projectKey: typeof projectKey === 'string' ? projectKey : undefined,
          issueKey: typeof issueKey === 'string' ? issueKey : undefined,
          meetingType: isMeetingType(meetingType) ? meetingType : undefined,
          durationMinutes: typeof durationMinutes === 'number' ? durationMinutes : undefined,
          sprintId: typeof sprintId === 'string' ? sprintId : undefined,
        });

        logger.debug('analyze_transcript results', {
          component: 'mcp/tool',
          tenantId: context.tenantId,
          accountId: context.accountId,
          meetingType: analysis.meeting.type,
          meetingSource: analysis.meeting.source,
          actions: analysis.actions.length,
        });

        return {
          content: [{ type: 'text' as const, text: formatActionsAsMarkdown(analysis) }],
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

  // jira_connect
  server.registerTool(
    'jira_connect',
    {
      title: 'Jira · Read — Get Jira authentication URL',
      description:
        'Get the Jira authentication URL to connect your Jira workspace to this tenant. Call this if Jira is not yet connected.',
      annotations: { readOnlyHint: true },
    },
    async (_args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_connect invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { db, tenantId } = context;

        if (!db) {
          return {
            content: [{ type: 'text' as const, text: 'Database not available' }],
            isError: true,
          };
        }

        // The caller's own grant only. A tenant-wide query here reported
        // "already connected as <someone else>" — one user's connection state
        // disclosed to another, and a dead end for the asker.
        const existingGrant = await db
          .selectFrom('provider_grants')
          .select(['display_name', 'metadata'])
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', 'atlassian')
          .where('provider_account_id', '=', context.accountId)
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

        // Send the user through this server's authorize route, which requires
        // a signed-in session and mints real CSRF state. A hand-built
        // auth.atlassian.com URL cannot work here: its state would never match
        // a pending_oidc_signin row, so the callback would reject it.
        const authUrl = `${context.origin ?? ''}/api/mcp/${tenantId}/authorize`;

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
