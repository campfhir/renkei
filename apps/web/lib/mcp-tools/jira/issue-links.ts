/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Issue linking tools for Jira MCP.
 * Create and manage relationships between issues.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function registerIssueLinkTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_list_link_types
  server.registerTool(
    'jira_list_link_types',
    {
      title: 'Jira · Read — List available issue link types',
      description: 'List all issue link types available in the Jira instance.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async (_args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_link_types invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const response = await auth.fetch(
          granularJiraScopes('jira_list_link_types', true),
          '/rest/api/3/issueLinkType'
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const linkTypes = data.issueLinkTypes || [];

        const lines = [
          `Found ${linkTypes.length} issue link types:`,
          // The directional phrases are what disambiguate jira_create_issue_link —
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

  // jira_create_issue_link
  server.registerTool(
    'jira_create_issue_link',
    {
      title: 'Jira · Act — Create an issue link',
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
      logger.debug('jira_create_issue_link invoked', {
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
        const typesResponse = await auth.fetch(
          granularJiraScopes('jira_create_issue_link', false),
          '/rest/api/3/issueLinkType'
        );
        if (!typesResponse.ok) return errText(await describeJiraAuthFailure(typesResponse));
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

        const response = await auth.fetch(
          granularJiraScopes('jira_create_issue_link', false),
          '/rest/api/3/issueLink',
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        // The API returns 201 Created with no body, so don't try to parse JSON
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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

  // jira_create_remote_link
  server.registerTool(
    'jira_create_remote_link',
    {
      title: 'Jira · Act — Add a web link to an issue',
      description:
        'Add an external URL to an issue’s Links panel (a "remote link" / web link) — ' +
        'use this instead of pasting a URL into a comment when the link should live with ' +
        'the issue. Pass the same globalId again to UPDATE that link in place rather than ' +
        'adding a duplicate.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        url: z.string().describe('The link target, e.g. https://docs.example.com/spec'),
        title: z.string().describe('Link text shown in the Links panel'),
        summary: z.string().describe('Optional tooltip/summary line').optional(),
        relationship: z
          .string()
          .describe('How the link relates, e.g. "documentation for" (optional)')
          .optional(),
        globalId: z
          .string()
          .describe(
            'Stable identity for upserts — posting the same globalId updates the existing ' +
              'link instead of creating another (optional)'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_create_remote_link invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const issueKey = typeof args.issueKey === 'string' ? args.issueKey : '';
        const url = typeof args.url === 'string' ? args.url : '';
        const title = typeof args.title === 'string' ? args.title : '';
        if (!issueKey || !url || !title) {
          return errText('issueKey, url, and title are required');
        }
        if (!/^https?:\/\//i.test(url)) {
          return errText('url must be an absolute http(s) URL — Jira rejects anything else.');
        }

        const body = {
          ...(typeof args.globalId === 'string' && args.globalId
            ? { globalId: args.globalId }
            : {}),
          ...(typeof args.relationship === 'string' && args.relationship
            ? { relationship: args.relationship }
            : {}),
          object: {
            url,
            title,
            ...(typeof args.summary === 'string' && args.summary ? { summary: args.summary } : {}),
          },
        };

        const response = await auth.fetch(
          granularJiraScopes('jira_create_remote_link', false),
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`,
          { method: 'POST', body: JSON.stringify(body) }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        // 201 = created, 200 = an existing link with this globalId was updated.
        const verb = response.status === 200 ? 'Updated' : 'Added';
        return {
          content: [
            {
              type: 'text' as const,
              text: `${verb} web link on ${issueKey}: "${title}" → ${url}`,
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

  // jira_delete_issue_link
  server.registerTool(
    'jira_delete_issue_link',
    {
      title: 'Jira · Act — Delete an issue link',
      description: 'Remove a relationship between two issues.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        linkId: z.string().describe('ID of the link to delete'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_delete_issue_link invoked', {
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

        const response = await auth.fetch(
          granularJiraScopes('jira_delete_issue_link', false),
          `/rest/api/3/issueLink/${linkId}`,
          { method: 'DELETE' }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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
