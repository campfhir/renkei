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

        // Decode base64 to binary
        const binaryString = Buffer.from(contentBase64, 'base64').toString('binary');
        const blob = Buffer.from(binaryString, 'binary');

        // Create form data for multipart upload
        const formData = new FormData();
        formData.append('file', new Blob([blob]), filename);

        const response = await fetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/attachments`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${context.accessToken}`,
              'X-Atlassian-Token': 'no-check',
            },
            body: formData,
          }
        );

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
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
