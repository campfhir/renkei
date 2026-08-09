/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Issue linking tools for Jira MCP.
 * Create and manage relationships between issues.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerIssueLinkTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // list_link_types
  server.registerTool(
    'list_link_types',
    {
      title: 'List available issue link types',
      description: 'List all issue link types available in the Jira instance.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async (_args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('list_link_types invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issueLinkType`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const linkTypes = data.issueLinkTypes || [];

        const lines = [
          `Found ${linkTypes.length} issue link types:`,
          // The directional phrases are what disambiguate create_issue_link —
          // "A blocks B" vs "A is blocked by B" is this list's whole value.
          ...linkTypes.map(
            (lt: any) => `• ${lt.name} (${lt.id}): outward "${lt.outward}" / inward "${lt.inward}"`
          ),
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // create_issue_link
  server.registerTool(
    'create_issue_link',
    {
      title: 'Create an issue link',
      description: 'Create a relationship between two issues.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        linkType: z.string().describe('Link type name, e.g. "blocks", "relates to", "duplicates"'),
        fromIssueKey: z.string().describe('Source issue key, e.g. PROJ-123'),
        toIssueKey: z.string().describe('Target issue key, e.g. PROJ-456'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('create_issue_link invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { linkType, fromIssueKey, toIssueKey } = args;

        if (!linkType || !fromIssueKey || !toIssueKey) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'linkType, fromIssueKey, and toIssueKey are required',
              },
            ],
            isError: true,
          };
        }

        // Resolve the type by name OR by either directional phrase — callers
        // say "blocks" (a phrase) as often as "Blocks" (the name). Direction:
        // Jira renders the OUTWARD issue as the subject of the outward phrase
        // ("A blocks B" ⇒ A is outwardIssue), so from = outward. The previous
        // mapping had it inverted and created every link backwards. Matching
        // on the inward phrase ("is blocked by") flips the pair.
        const typesResponse = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issueLinkType`,
          context.accessToken
        );
        const typesBody = (await typesResponse.json()) as any;
        const types: any[] = Array.isArray(typesBody?.issueLinkTypes)
          ? typesBody.issueLinkTypes
          : [];
        const wanted = (linkType as string).toLowerCase();
        const byName = types.find((t) => t.name?.toLowerCase() === wanted);
        const byOutward = types.find((t) => t.outward?.toLowerCase() === wanted);
        const byInward = types.find((t) => t.inward?.toLowerCase() === wanted);
        const match = byName ?? byOutward ?? byInward;
        if (!match) {
          const catalog = types
            .map((t) => `${t.name} (outward "${t.outward}" / inward "${t.inward}")`)
            .join('; ');
          return {
            content: [
              {
                type: 'text' as const,
                text: `No link type matches "${linkType}". Available: ${catalog}`,
              },
            ],
            isError: true,
          };
        }
        const invert = !byName && !byOutward && Boolean(byInward);
        const outwardKey = (invert ? toIssueKey : fromIssueKey) as string;
        const inwardKey = (invert ? fromIssueKey : toIssueKey) as string;

        const body = {
          type: { name: match.name as string },
          outwardIssue: { key: outwardKey },
          inwardIssue: { key: inwardKey },
        };

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issueLink`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        // The API returns 201 Created with no body, so don't try to parse JSON
        if (!response.ok) {
          throw new Error(`Failed to create link: ${response.statusText}`);
        }

        // State the link the way Jira will render it, not the raw input —
        // the direction semantics are exactly what callers get wrong.
        const reading = invert ? match.inward : match.outward;
        const lines = [
          `Link created: ${fromIssueKey} ${reading} ${toIssueKey} (type: ${match.name})`,
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // delete_issue_link
  server.registerTool(
    'delete_issue_link',
    {
      title: 'Delete an issue link',
      description: 'Remove a relationship between two issues.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        linkId: z.string().describe('ID of the link to delete'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('delete_issue_link invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { linkId } = args;

        if (!linkId) {
          return {
            content: [{ type: 'text' as const, text: 'linkId is required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issueLink/${linkId}`,
          context.accessToken,
          { method: 'DELETE' }
        );

        return {
          content: [{ type: 'text' as const, text: `Link ${linkId} deleted` }],
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
