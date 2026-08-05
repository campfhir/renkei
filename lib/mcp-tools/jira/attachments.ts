/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attachment tools for Jira MCP.
 * Handle file uploads and downloads.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, toolError } from '../common';

export interface AttachmentToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const attachmentTools: AttachmentToolHandler[] = [
  {
    name: 'add_attachment',
    description: 'Upload a file attachment to a Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
        filename: {
          type: 'string',
          description: 'File name to store as',
        },
        contentBase64: {
          type: 'string',
          description: 'File content as base64',
        },
      },
      required: ['issueKey', 'filename', 'contentBase64'],
    },
    handler: async (context, params) => {
      const { issueKey, filename, contentBase64 } = params;

      if (!issueKey || !filename || !contentBase64) {
        return toolError('issueKey, filename, and contentBase64 are required');
      }

      try {
        // Decode base64 to binary
        const binaryString = Buffer.from(contentBase64, 'base64').toString('binary');
        const blob = Buffer.from(binaryString, 'binary');

        // Create form data for multipart upload
        const formData = new FormData();
        formData.append('file', new Blob([blob]), filename);

        const response = await fetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/attachments`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${context.accessToken}`,
              'X-Atlassian-Token': 'no-check',
            },
            body: formData,
          },
        );

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }

        return ok(`Attached ${filename} to ${issueKey}`);
      } catch (error) {
        return toolError(`Failed to add attachment: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
