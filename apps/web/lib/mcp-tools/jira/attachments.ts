/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attachment tools for Jira MCP.
 * Handle file uploads and downloads.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

/** Fallback when no limit is on the context; matches the org-settings default. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20_971_520; // 20MB

export async function registerAttachmentTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_add_attachment
  server.registerTool(
    'jira_add_attachment',
    {
      title: 'Jira · Act — Attach a file to a Jira issue',
      description: 'Upload a file attachment to a Jira issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        filename: z.string().describe('File name to store as'),
        contentBase64: z.string().describe('File content as base64'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_add_attachment invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, filename, contentBase64 } = args;

        if (!issueKey || !filename || !contentBase64) {
          return {
            content: [
              { type: 'text' as const, text: 'issueKey, filename, and contentBase64 are required' },
            ],
            isError: true,
          };
        }

        const buffer = Buffer.from(contentBase64, 'base64');

        const maxBytes = context.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
        if (buffer.byteLength > maxBytes) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Attachment is ${buffer.byteLength} bytes; the limit is ${maxBytes} bytes (MAX_ATTACHMENT_BYTES)`,
              },
            ],
            isError: true,
          };
        }

        // Create form data for multipart upload
        const formData = new FormData();
        formData.append('file', new Blob([buffer]), filename);

        // Through auth.fetch, not bare fetch: an expired token gets refreshed
        // and retried instead of failing the upload, and a refusal surfaces
        // Jira's actual reason rather than a bare status text.
        const response = await auth.fetch(
          granularJiraScopes('jira_add_attachment', false),
          `/rest/api/3/issue/${issueKey}/attachments`,
          {
            method: 'POST',
            headers: { 'X-Atlassian-Token': 'no-check' },
            body: formData,
          }
        );
        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: await describeJiraAuthFailure(response) }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Attached ${filename} to ${issueKey}` }],
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
