/**
 * Upload slots — the out-of-band byte path that replaced every
 * contentBase64 tool parameter.
 *
 * An MCP tool argument is text the CALLING MODEL must generate: megabytes
 * of base64 is hundreds of thousands of output tokens, which reads as the
 * tool "hanging" while the request never reaches the server at all. So a
 * *_request_*_upload tool mints a slot here and hands back a short-lived
 * endpoint; the actual bytes are POSTed to /api/upload/{slotId} with the
 * opaque bearer in the Authorization header (curl from a shell, or the
 * route's built-in browser page, where the token rides the URL FRAGMENT so
 * it never appears in server logs).
 *
 * The slot id in the URL is non-secret; only the sha256 of the bearer is
 * stored. The POST's conditional claim makes each slot single-use.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import type { MCPToolContext } from './common';

export const UPLOAD_SLOT_TTL_MS = 15 * 60_000;
export const DEFAULT_UPLOAD_MAX_BYTES = 20_971_520; // 20MB

export type UploadSlotKind =
  | 'jira-attachment'
  | 'jsm-attachment'
  | 'confluence-attachment'
  | 'onedrive-document'
  | 'sharepoint-document'
  | 'outlook-draft-attachment'
  | 'fileshare-file'
  | 'onbase-document';

export function hashUploadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedUploadSlot {
  ok: true;
  uploadId: string;
  /** The full instruction text a tool returns to the model. */
  instructions: string;
}

export async function createUploadSlot(
  context: MCPToolContext,
  kind: UploadSlotKind,
  destination: Record<string, unknown>,
  file: { filename: string; contentType?: string; maxBytes?: number }
): Promise<CreatedUploadSlot | { ok: false; error: string }> {
  if (!context.subject) return { ok: false, error: 'No signed-in identity on this request.' };
  const base = context.origin || getPublicBaseUrl();
  if (!base) {
    return {
      ok: false,
      error: 'PUBLIC_BASE_URL is not configured — the server cannot mint upload endpoints.',
    };
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return { ok: false, error: 'Database unavailable.' };

  const uploadId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const maxBytes = file.maxBytes ?? context.maxAttachmentBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  await dbResult.val
    .insertInto('upload_slots')
    .values({
      id: uploadId,
      token_hash: hashUploadToken(token),
      tenant_id: context.tenantId,
      subject: context.subject,
      account_id: context.accountId,
      kind,
      destination: JSON.stringify(destination),
      filename: file.filename,
      content_type: file.contentType ?? null,
      max_bytes: maxBytes,
      expires_at: new Date(Date.now() + UPLOAD_SLOT_TTL_MS),
    })
    .execute();

  const url = `${base.replace(/\/$/, '')}/api/upload/${uploadId}`;
  const minutes = Math.round(UPLOAD_SLOT_TTL_MS / 60_000);
  const megabytes = Math.floor(maxBytes / 1_048_576);
  const instructions = [
    `Upload endpoint ready for "${file.filename}" (id ${uploadId}); single-use, expires in ${minutes} minutes, up to ${megabytes} MB.`,
    'Send the RAW file bytes (not base64) one of these ways:',
    `- From a shell: curl -sS -X POST --data-binary @'${file.filename}' -H 'Authorization: Bearer ${token}' '${url}'`,
    `- In a browser, open: ${url}#${token} and pick the file.`,
    `The response reports the outcome; check_file_upload with uploadId "${uploadId}" confirms it.`,
  ].join('\n');
  return { ok: true, uploadId, instructions };
}

/**
 * check_file_upload — the one cross-connector status tool for slots. Read
 * only and scoped by tenant AND subject: a foreign upload id is
 * indistinguishable from a nonexistent one.
 */
export function registerUploadStatusTool(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'check_file_upload',
    {
      title: 'Renkei · Read — Check a requested file upload',
      description:
        'Status of an upload endpoint minted by a *_request_*_upload tool: pending (waiting ' +
        'for bytes), completed, failed, or expired — with the destination outcome.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        uploadId: z.string().uuid().describe('The id the *_request_*_upload tool returned'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const uploadId = typeof args.uploadId === 'string' ? args.uploadId : '';
      if (!uploadId) {
        return {
          content: [{ type: 'text' as const, text: 'uploadId is required' }],
          isError: true,
        };
      }
      if (!context.subject) {
        return {
          content: [{ type: 'text' as const, text: 'No signed-in identity on this request.' }],
          isError: true,
        };
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) {
        return {
          content: [{ type: 'text' as const, text: 'Database unavailable.' }],
          isError: true,
        };
      }
      const slot = await dbResult.val
        .selectFrom('upload_slots')
        .select(['id', 'kind', 'filename', 'status', 'result', 'expires_at', 'completed_at'])
        .where('id', '=', uploadId)
        .where('tenant_id', '=', context.tenantId)
        .where('subject', '=', context.subject)
        .executeTakeFirst();
      if (!slot) {
        return { content: [{ type: 'text' as const, text: 'No such upload.' }], isError: true };
      }
      const expired = slot.status === 'pending' && new Date(slot.expires_at).getTime() < Date.now();
      const lines = [
        `Upload ${slot.id} ("${slot.filename}", ${slot.kind}): ${expired ? 'expired' : slot.status}.`,
        ...(slot.result ? [slot.result] : []),
        ...(slot.status === 'pending' && !expired
          ? ['Waiting for the bytes — POST them to the endpoint from the request step.']
          : []),
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );
}
