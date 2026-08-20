/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attachments: v2 for list/delete, v1 for upload — confirmed the v2
 * attachment group has no create endpoint at all, so upload has to go
 * through the legacy multipart content-child-attachment route regardless
 * of how "v2" the rest of this connector is.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confluenceGet,
  confluenceDelete,
  values,
  textResult,
  errText,
  str,
} from './client';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { ConfluenceAuth } from './confluence-auth';
import { createUploadSlot } from '../upload-slots';

/** Fallback when no limit is on the context; matches the org-settings default. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20_971_520; // 20MB

const CONTENT_TYPE_PATH: Record<string, string> = { page: 'pages', blogpost: 'blogposts' };

function attachmentLine(attachment: Record<string, unknown>): string {
  return (
    `${str(attachment.title) || '(untitled)'} — ${str(attachment.mediaType) || 'unknown type'}` +
    (typeof attachment.fileSize === 'number' ? ` — ${attachment.fileSize} bytes` : '') +
    ` — id: ${str(attachment.id)}`
  );
}

export async function registerAttachmentTools(
  server: McpServer,
  context: MCPToolContext,
  auth: ConfluenceAuth
): Promise<void> {
  server.registerTool(
    'confluence_list_attachments',
    {
      title: 'Confluence · Read — List attachments on a page or blog post',
      description: 'List the files attached to a page or blog post.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page or blog post id'),
        contentType: z.enum(['page', 'blogpost']),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');
      const path = CONTENT_TYPE_PATH[str(args.contentType)];
      if (!path) return errText('contentType must be one of page, blogpost');
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/${path}/${encodeURIComponent(contentId)}/attachments?limit=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(attachmentLine);
      if (lines.length === 0) return textResult('No attachments.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Name, Type, Size, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_request_attachment_upload',
    {
      title: 'Confluence · Act — Request an upload endpoint for an attachment',
      description:
        'Attach a NEW file to a page or blog post — without base64. Returns a short-lived ' +
        'single-use endpoint; send the raw bytes there (curl with the Authorization header, ' +
        'or the returned browser link). Never generate file content as a tool argument.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page or blog post id'),
        filename: z.string().min(1).describe('File name to store as'),
        comment: z.string().describe('Comment shown alongside the attachment').optional(),
        contentType: z.string().describe('MIME type (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');
      const filename = str(args.filename);
      if (!filename) return errText('filename is required');

      const slot = await createUploadSlot(
        context,
        'confluence-attachment',
        { contentId, ...(str(args.comment) ? { comment: str(args.comment) } : {}) },
        {
          filename,
          contentType: str(args.contentType) || undefined,
          maxBytes: context.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
        }
      );
      if (!slot.ok) return errText(slot.error);
      return textResult(slot.instructions);
    }
  );

  server.registerTool(
    'confluence_delete_attachment',
    {
      title: 'Confluence · Act — Delete an attachment',
      description: 'Remove an attachment.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        attachmentId: z.string().min(1).describe('Attachment id from confluence_list_attachments'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const attachmentId = str(args.attachmentId);
      if (!attachmentId) return errText('attachmentId is required');
      const result = await confluenceDelete(
        context,
        access,
        `/api/v2/attachments/${encodeURIComponent(attachmentId)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult('Attachment deleted.');
    }
  );
}
