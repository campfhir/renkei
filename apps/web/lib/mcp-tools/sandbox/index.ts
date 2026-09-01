/**
 * The sandbox_* tools — a per-caller scratch space (apps/worker-sandbox)
 * for staging a file mid-task, e.g. pulling it off a network file share
 * (which only offers a download link) and handing it to a connector that
 * only accepts staged upload bytes (OnBase, Jira, ...). Nothing here is a
 * general shell: every operation is one named, bounded thing the worker
 * does itself — download a URL, read back what's staged, forward it into
 * an already-requested upload — never an arbitrary command.
 *
 * File bytes never travel as tool arguments here either: sandbox_download_url
 * and sandbox_fetch_from_fileshare have the WORKER (or the web app, for the
 * fileshare pull) fetch the bytes itself, and sandbox_send_to_upload reads
 * them back out and forwards them into an upload slot server-side. The
 * model only ever sees filenames, sizes, and ids.
 *
 * Staged files are short-lived on purpose (see
 * docs/sandbox-connector-design.md): a fixed TTL and a per-caller quota,
 * enforced by the worker's own sweep, not left to the caller to clean up.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { extractText, DEFAULT_MAX_INPUT_BYTES } from '@renkei/document-text';
import type { MCPToolContext } from '../common';
import { claimPendingUploadSlotByOwner } from '../upload-slots';
import { completeUploadSlot, finalizeUploadSlot } from '@/lib/upload-executors';
import { getDatabase } from '@renkei/db';
import { fsReadFile, clientFailure as fileshareClientFailure } from '@/lib/file-shares/service-client';
import {
  sbFetchUrl,
  sbListFiles,
  sbStatFile,
  sbReadFile,
  sbWriteFile,
  sbDeleteFile,
  clientFailure,
  sandboxConfig,
  type WireSandboxFile,
} from '@/lib/sandbox/service-client';

/** The connector key the sandbox capabilities register under. */
export const SANDBOX_MCP_CONNECTOR = 'sandbox';

/** Whether this deployment runs a sandbox worker at all — gates registration. */
export function sandboxWorkerConfigured(): boolean {
  return sandboxConfig() !== null;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function targetOf(context: MCPToolContext): { tenantId: string; subject: string } | string {
  if (!context.subject) return 'No signed-in identity on this request.';
  return { tenantId: context.tenantId, subject: context.subject };
}

function fileLine(file: WireSandboxFile): string {
  const age = new Date(file.createdAt).toLocaleString();
  return `${file.id} — "${file.filename}" — ${file.sizeBytes} bytes — staged ${age} — expires ${new Date(file.expiresAt).toLocaleString()}`;
}

export function registerSandboxTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'sandbox_download_url',
    {
      title: 'Sandbox · Act — Download a file from a URL into your scratch space',
      description:
        'Fetch an https:// URL and stage the bytes in your scratch space, for when a file ' +
        'lives somewhere with no dedicated Renkei connector. The WORKER fetches the URL — ' +
        'the model never generates or sees the bytes. Private/internal addresses are refused ' +
        '(no localhost, no cloud metadata, no internal network). Staged files expire after a ' +
        'day and count against a per-caller quota; sandbox_delete_file removes one early.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        url: z.string().url().describe('An https:// URL to fetch.'),
        filename: z.string().min(1).max(255).describe('Name to store the file as.'),
        contentType: z.string().optional().describe('MIME type, if known.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const fetched = await sbFetchUrl(target, {
        url: str(args.url),
        filename: str(args.filename),
        contentType: str(args.contentType) || undefined,
      });
      if (!fetched.ok) return errText(clientFailure(fetched.err).message);
      return textResult(`Staged ${fileLine(fetched.val)}`);
    }
  );

  server.registerTool(
    'sandbox_fetch_from_fileshare',
    {
      title: 'Sandbox · Act — Copy a file from a network share into your scratch space',
      description:
        'Pull a file from a connected SMB/SFTP share (see fileshare_list_shares) straight ' +
        'into your scratch space, server-to-server — no download link, no bytes through the ' +
        'model. This is the direct route from a file share to a connector like OnBase or ' +
        'Jira that only accepts staged upload bytes: fetch it here, then sandbox_send_to_upload.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().min(1).describe('File path from the share root, Unix style.'),
        filename: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Name to store as (default: the source file name).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const path = str(args.path);
      const read = await fsReadFile(
        { tenantId: target.tenantId, subject: target.subject, shareId: str(args.shareId) },
        path,
        context.maxAttachmentBytes
      );
      if (!read.ok) return errText(fileshareClientFailure(read.err).message);

      const filename = str(args.filename) || path.slice(path.lastIndexOf('/') + 1) || 'file';
      const staged = await sbWriteFile(
        target,
        { filename, source: `fileshare:${str(args.shareId)}` },
        read.val
      );
      if (!staged.ok) return errText(clientFailure(staged.err).message);
      return textResult(`Staged ${fileLine(staged.val)}`);
    }
  );

  server.registerTool(
    'sandbox_list_files',
    {
      title: 'Sandbox · Read — List what you have staged',
      description: 'The files currently in your scratch space, with size and expiry.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const listed = await sbListFiles(target);
      if (!listed.ok) return errText(clientFailure(listed.err).message);
      if (listed.val.length === 0) return textResult('Nothing is staged in your scratch space.');
      return textResult(listed.val.map(fileLine).join('\n'));
    }
  );

  server.registerTool(
    'sandbox_stat_file',
    {
      title: 'Sandbox · Read — Details of one staged file',
      description: 'Filename and content type for one file in your scratch space.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        fileId: z.string().uuid().describe('From sandbox_list_files or a stage tool.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const stat = await sbStatFile(target, str(args.fileId));
      if (!stat.ok) return errText(clientFailure(stat.err).message);
      return textResult(
        `${stat.val.id} — "${stat.val.filename}"${stat.val.contentType ? ` — ${stat.val.contentType}` : ''}`
      );
    }
  );

  server.registerTool(
    'sandbox_read_file',
    {
      title: 'Sandbox · Read — Read a staged file as text',
      description:
        'Extract the text of a staged file — plain files decoded directly, documents (pdf, ' +
        'docx, xlsx, pptx, html) through text extraction.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        fileId: z.string().uuid().describe('From sandbox_list_files or a stage tool.'),
        maxChars: z.number().int().positive().optional().describe('Cap on returned characters (default 60000).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const read = await sbReadFile(target, str(args.fileId));
      if (!read.ok) return errText(clientFailure(read.err).message);

      const maxBytes = Math.min(
        DEFAULT_MAX_INPUT_BYTES,
        context.maxAttachmentBytes ?? DEFAULT_MAX_INPUT_BYTES
      );
      if (read.val.bytes.byteLength > maxBytes) {
        return errText(`"${read.val.filename}" is too large to read here — try sandbox_send_to_upload instead.`);
      }
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 60_000;
      const extracted = await extractText(read.val.bytes, { fileName: read.val.filename, maxChars });
      if (!extracted.ok) {
        return errText(
          extracted.err.type === 'UNSUPPORTED_FORMAT'
            ? `"${read.val.filename}" is not a text-extractable format.`
            : `Could not extract text from "${read.val.filename}" (${extracted.err.type}).`
        );
      }
      const notes = extracted.val.notes.length ? `\n[note: ${extracted.val.notes.join('; ')}]` : '';
      return textResult(`${extracted.val.text}${notes}`);
    }
  );

  server.registerTool(
    'sandbox_delete_file',
    {
      title: 'Sandbox · Act — Delete a staged file',
      description: 'Remove one file from your scratch space early, ahead of its expiry.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        fileId: z.string().uuid().describe('From sandbox_list_files or a stage tool.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const deleted = await sbDeleteFile(target, str(args.fileId));
      if (!deleted.ok) return errText(clientFailure(deleted.err).message);
      return textResult(`Deleted ${deleted.val.id} from your scratch space.`);
    }
  );

  server.registerTool(
    'sandbox_send_to_upload',
    {
      title: 'Sandbox · Act — Send a staged file to a pending upload',
      description:
        'Complete a *_request_*_upload (onbase_request_document_upload, ' +
        'jira_request_attachment_upload, ...) with the bytes of a file already staged here — ' +
        'no curl, no browser, the web app reads the staged bytes and forwards them itself. ' +
        'This is what actually MOVES a staged file into its destination; confirm the result ' +
        'with check_file_upload the same way you would after a manual upload.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        fileId: z.string().uuid().describe('From sandbox_list_files or a stage tool.'),
        uploadId: z.string().uuid().describe('From the *_request_*_upload tool that started this upload.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const read = await sbReadFile(target, str(args.fileId));
      if (!read.ok) return errText(clientFailure(read.err).message);

      const claimed = await claimPendingUploadSlotByOwner(context, str(args.uploadId));
      if (!claimed.ok) return errText(claimed.error);

      // claimPendingUploadSlotByOwner already proved the database is
      // reachable (it just claimed the slot through it); this second call
      // only fails on a connection lost in the instant since, which leaves
      // the slot claimed-but-unfinalized — the same edge case
      // /api/upload/[slotId] already accepts between its own claim and
      // finish.
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      if (read.val.bytes.byteLength > claimed.val.max_bytes) {
        const outcome = await finalizeUploadSlot(db, claimed.val, {
          ok: false,
          detail: `The staged file exceeds this upload's ${claimed.val.max_bytes}-byte limit.`,
        });
        return errText(outcome.detail);
      }

      const outcome = await completeUploadSlot(db, claimed.val, Buffer.from(read.val.bytes));
      return outcome.ok ? textResult(outcome.detail) : errText(outcome.detail);
    }
  );
}
