/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attachment tools for Jira MCP.
 * Handle file uploads and downloads.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, jiraFetch } from '../common';
import { logger } from '@/lib/logger';

/** Fallback when no config is on the context; matches the env default. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20_971_520; // 20MB

export async function registerAttachmentTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // add_attachment
  server.registerTool(
    'add_attachment',
    {
      title: 'Attach a file to a Jira issue',
      description: 'Upload a file attachment to a Jira issue.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        filename: z.string().describe('File name to store as'),
        contentBase64: z.string().describe('File content as base64'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] add_attachment invoked', {
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

        const maxBytes = context.config?.MAX_ATTACHMENT_BYTES ?? DEFAULT_MAX_ATTACHMENT_BYTES;
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

        // Through jiraFetch, not bare fetch: an expired token gets refreshed
        // and retried instead of failing the upload, and a refusal surfaces
        // Jira's actual reason rather than a bare status text.
        await jiraFetch(`${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/attachments`, context.accessToken, {
          method: 'POST',
          headers: { 'X-Atlassian-Token': 'no-check' },
          body: formData,
        });

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
