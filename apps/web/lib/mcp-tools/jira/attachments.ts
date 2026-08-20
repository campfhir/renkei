/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attachment tools for Jira MCP — deliberately WITHOUT a base64 content
 * parameter. A tool argument is text the calling model must generate, and
 * megabytes of base64 is hundreds of thousands of output tokens that read
 * as the tool "hanging" while the server never sees a request. Bytes reach
 * an issue two ways instead:
 *
 *   - jira_request_attachment_upload → an out-of-band endpoint the client
 *     POSTs the RAW file to (upload-slots.ts + /api/upload/[slotId]).
 *   - jira_add_attachment → server-side sources: a OneDrive/SharePoint
 *     item, or an attachment on an Outlook message — fetched under the
 *     user's own Microsoft grant, then forwarded to Jira; no bytes ever
 *     transit the model.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';
import { decodeBase64Attachment } from '../fetch-guard';
import { graphDownload } from '@renkei/connector-microsoft';
import { graphGet, resolveGraphAccess, str, rec } from '../graph/client';
import { createUploadSlot } from '../upload-slots';

/** Fallback when no limit is on the context; matches the org-settings default. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20_971_520; // 20MB

export async function registerAttachmentTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  const maxBytes = context.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  const uploadToJira = async (
    issueKey: string,
    filename: string,
    bytes: Uint8Array
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (bytes.byteLength > maxBytes) {
      return {
        ok: false,
        error: `Attachment is ${bytes.byteLength} bytes; the limit is ${maxBytes} bytes (MAX_ATTACHMENT_BYTES)`,
      };
    }
    const formData = new FormData();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    formData.append('file', new Blob([copy]), filename);
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
    if (!response.ok) return { ok: false, error: await describeJiraAuthFailure(response) };
    return { ok: true };
  };

  // jira_add_attachment — server-side sources only.
  server.registerTool(
    'jira_add_attachment',
    {
      title: 'Jira · Act — Attach a file from Microsoft 365 to a Jira issue',
      description:
        'Attach a file that already lives in Microsoft 365 — a OneDrive/SharePoint item ' +
        '(driveItem) or an attachment on an Outlook message (outlookAttachment). The server ' +
        'fetches the bytes itself; never generate file content as a tool argument. For a NEW ' +
        'file that lives nowhere yet, use jira_request_attachment_upload instead.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        filename: z
          .string()
          .describe('Name to store as (default: the source file/attachment name)')
          .optional(),
        driveItem: z
          .object({
            driveId: z.string().min(1).describe('Drive id from onedrive_*/sharepoint_* tools'),
            itemId: z.string().min(1).describe('Item id from onedrive_*/sharepoint_* tools'),
          })
          .describe('A OneDrive/SharePoint file to attach')
          .optional(),
        outlookAttachment: z
          .object({
            messageId: z.string().min(1).describe('Message id from outlook_* tools'),
            attachmentId: z.string().min(1).describe('Attachment id from outlook_list_attachments'),
          })
          .describe('An attachment on an Outlook message to copy onto the issue')
          .optional(),
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
        const issueKey = str(args.issueKey);
        if (!issueKey) {
          return { content: [{ type: 'text' as const, text: 'issueKey is required' }], isError: true };
        }
        const driveItem = args.driveItem;
        const outlookAttachment = args.outlookAttachment;
        if (Boolean(driveItem) === Boolean(outlookAttachment)) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'Provide exactly one source: driveItem or outlookAttachment. For a new ' +
                  'file, use jira_request_attachment_upload.',
              },
            ],
            isError: true,
          };
        }

        const graphAccess = await resolveGraphAccess(context);
        if (typeof graphAccess === 'string') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Connect Microsoft 365 to attach from OneDrive/SharePoint/Outlook: ${graphAccess}`,
              },
            ],
            isError: true,
          };
        }

        let bytes: Uint8Array;
        let filename = str(args.filename);
        if (driveItem) {
          const downloaded = await graphDownload(
            graphAccess.accessToken,
            str(driveItem.driveId),
            str(driveItem.itemId),
            { maxBytes, lane: 'interactive' }
          );
          if (!downloaded.ok) {
            const message = str(rec(downloaded.err).message) || 'Could not download the file.';
            return { content: [{ type: 'text' as const, text: message }], isError: true };
          }
          bytes = downloaded.val.bytes;
          filename = filename || str(downloaded.val.item.name) || 'attachment';
        } else {
          const messageId = str(outlookAttachment.messageId);
          const attachmentId = str(outlookAttachment.attachmentId);
          const result = await graphGet(
            context,
            graphAccess.accessToken,
            `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
          );
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: result.error }], isError: true };
          }
          const contentBytes = str(result.body.contentBytes);
          if (!contentBytes) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'That attachment carries no file content (item/reference attachments cannot be copied).',
                },
              ],
              isError: true,
            };
          }
          const decoded = decodeBase64Attachment(contentBytes);
          if (!decoded.ok) {
            return { content: [{ type: 'text' as const, text: decoded.error }], isError: true };
          }
          bytes = new Uint8Array(decoded.buffer);
          filename = filename || str(result.body.name) || 'attachment';
        }

        const uploaded = await uploadToJira(issueKey, filename, bytes);
        if (!uploaded.ok) {
          return { content: [{ type: 'text' as const, text: uploaded.error }], isError: true };
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

  // jira_request_attachment_upload — the new-file path.
  server.registerTool(
    'jira_request_attachment_upload',
    {
      title: 'Jira · Act — Request an upload endpoint for a new attachment',
      description:
        'Attach a NEW file to an issue — without base64. Returns a short-lived single-use ' +
        'endpoint; send the raw bytes there (curl with the Authorization header, or the ' +
        'returned browser link). Never generate file content as a tool argument.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        filename: z.string().min(1).describe('File name to store as'),
        contentType: z.string().describe('MIME type (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const issueKey = str(args.issueKey);
      const filename = str(args.filename);
      if (!issueKey || !filename) {
        return {
          content: [{ type: 'text' as const, text: 'issueKey and filename are required' }],
          isError: true,
        };
      }
      const slot = await createUploadSlot(
        context,
        'jira-attachment',
        { issueKey },
        { filename, contentType: str(args.contentType) || undefined, maxBytes }
      );
      if (!slot.ok) {
        return { content: [{ type: 'text' as const, text: slot.error }], isError: true };
      }
      logger.info('jira_request_attachment_upload minted {uploadId}', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        uploadId: slot.uploadId,
        issueKey,
      });
      return { content: [{ type: 'text' as const, text: slot.instructions }] };
    }
  );
}
