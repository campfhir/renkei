/**
 * The fileshare_* tools — org-registered SMB/SFTP shares where Renkei's own
 * grant/rule store is the ACL authority (there is no provider to delegate
 * to: the backend connection uses one admin-held service credential).
 *
 * Since the dedicated fileshare worker took over all share I/O, these
 * handlers hold no protocol session and decrypt no credential: every
 * operation crosses the authenticated seam to apps/worker-fileshares,
 * which resolves the caller's ACL context fresh and enforces the per-path
 * check itself. What stays here is the model-facing boundary — path
 * normalization phrased as refusals a model can act on, the upload-slot
 * mint, the preview card — plus the store-only discovery reads. The
 * capability gate only decides whether the tools exist for a caller; it
 * never substitutes for the worker's per-path check.
 *
 * No scope gate: fileshares has no OAuth scopes (the cards/agents
 * precedent), so registration wraps only the capability gate the registry
 * applies. Listings annotate every entry with the caller's own permission,
 * because "what may I do here" is the question a model asks next.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { extractText, DEFAULT_MAX_INPUT_BYTES } from '@renkei/document-text';
import { childPath, effectiveAccess, normalizePath } from '@renkei/connector-fileshares';
import type { AccessLevel, GrantedShare } from '@renkei/connector-fileshares';
import type { MCPToolContext } from '../common';
import {
  fsListFolder,
  fsMakeFolder,
  fsMoveEntry,
  fsPreviewRemove,
  fsReadFile,
  fsRemoveEntry,
  fsRenameEntry,
  fsStatEntry,
} from '@/lib/file-shares/service-client';
import type { FileshareClientError, WireEntry } from '@/lib/file-shares/service-client';
import { createUploadSlot } from '../upload-slots';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import { NO_STORED_CREDENTIALS, NO_SUCH_SHARE } from './fileshare-auth';
import type { FileshareAuth } from './fileshare-auth';

/** The connector key the fileshare capabilities register under. */
export const FILESHARES_MCP_CONNECTOR = 'fileshares';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function accessWord(level: AccessLevel): string {
  return level === 'read_write' ? 'read/write' : level;
}

/** Normalize a model-supplied path, or return the refusal to hand back. */
function inputPath(raw: unknown): { ok: true; path: string } | { ok: false; error: string } {
  const normalized = normalizePath(str(raw));
  if (!normalized.ok) {
    return {
      ok: false,
      error:
        normalized.err.type === 'PATH_TRAVERSAL'
          ? 'That path climbs out of the share (".." is not allowed here). Give the path from the share root, like /reports/q4.'
          : 'That is not a usable path.',
    };
  }
  return { ok: true, path: normalized.val };
}

function entryLine(entry: WireEntry): string {
  const marker = entry.access === 'traverse' ? '[folders below]' : `[${accessWord(entry.access)}]`;
  if (entry.kind === 'dir') return `${entry.path}/ ${marker}`;
  const size = entry.size !== null ? ` · ${entry.size} bytes` : '';
  const when = entry.modifiedAt ? ` · modified ${entry.modifiedAt}` : '';
  return `${entry.path} ${marker}${size}${when}`;
}

function shareLine(granted: GrantedShare): string {
  const target =
    granted.share.protocol === 'smb'
      ? `smb://${granted.share.host}/${granted.share.shareName ?? ''}`
      : `sftp://${granted.share.host}`;
  const access =
    granted.grant.defaultAccess === 'none'
      ? 'specific folders only'
      : accessWord(granted.grant.defaultAccess);
  const rules = granted.hasRules ? ' (path rules apply)' : '';
  return `${granted.share.name} — id ${granted.share.id} — ${target} — your access: ${access}${rules}`;
}

/**
 * Phrase a worker refusal or failure for the model. The worker's own
 * messages (ACL refusals, gate refusals, path complaints) pass through —
 * they are written user-facing at the source, once, so REST and MCP agree.
 */
function clientMessage(what: string, error: FileshareClientError): string {
  if (error.kind === 'unconfigured') {
    return 'File shares are unavailable: the file share service is not configured on this deployment.';
  }
  if (error.kind === 'unreachable') {
    return `Could not reach the file share service to ${what}.`;
  }
  switch (error.type) {
    case 'no_share':
      return NO_SUCH_SHARE;
    case 'no_credentials':
      return NO_STORED_CREDENTIALS;
    case 'bad_credentials':
      return 'The stored credentials for this share cannot be read — an administrator must re-enter them.';
    case 'store':
      return 'Could not read your file share access.';
    case 'forbidden':
      return error.message ?? 'You do not have access to that.';
    case 'bad_path':
      return error.message ?? 'That is not a usable path.';
    case 'not_found':
      return 'Nothing exists at that path.';
    case 'access_denied':
      return `The file server refused to ${what} with the share's service credential.`;
    case 'timeout':
      return `The file server did not answer in time trying to ${what}.`;
    case 'too_large':
      return error.message ?? 'The file is too large to read here.';
    case 'connection':
      return `Could not reach the file server to ${what}.`;
    case 'exists':
      return error.message ?? 'Something already exists at the destination.';
    case 'not_empty':
      return 'The folder is not empty — only empty folders can be deleted (delete its contents first).';
    default:
      return `Could not ${what}: ${error.message ?? error.type}.`;
  }
}

export function registerFileshareTools(
  server: McpServer,
  context: MCPToolContext,
  auth: FileshareAuth
): void {
  server.registerTool(
    'fileshare_list_shares',
    {
      title: 'FileShares · Read — List the network shares you can use',
      description:
        'The org file shares (SMB/SFTP) you have been granted access to, with the access ' +
        'level you hold on each. Every other fileshare_* tool takes the shareId listed here. ' +
        'Shares you have no grant for are not listed and cannot be reached.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const granted = await auth.listGranted();
      if (typeof granted === 'string') return errText(granted);
      if (granted.length === 0) {
        return textResult('You have not been granted access to any file shares.');
      }
      return textResult(
        `Shares you can use:\n${granted.map((entry) => shareLine(entry)).join('\n')}`
      );
    }
  );

  server.registerTool(
    'fileshare_list_folder',
    {
      title: 'FileShares · Read — List a folder on a share',
      description:
        'List the entries of a folder on a granted share. Each entry carries the access you ' +
        'hold on it — [read], [read/write], or [folders below] for a folder you may only ' +
        'traverse. Entries you cannot access at all are not shown.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z
          .string()
          .optional()
          .describe('Folder path from the share root (default "/"). Unix style: /reports/q4'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const path = inputPath(args.path ?? '/');
      if (!path.ok) return errText(path.error);

      const listed = await fsListFolder({ ...target, shareId: str(args.shareId) }, path.path);
      if (!listed.ok) return errText(clientMessage('list the folder', listed.err));

      if (listed.val.entries.length === 0) {
        return textResult(`${listed.val.path} has no entries you can access.`);
      }
      return textResult(
        `${listed.val.path} on "${listed.val.share.name}":\n` +
          listed.val.entries.map((entry) => entryLine(entry)).join('\n')
      );
    }
  );

  server.registerTool(
    'fileshare_stat',
    {
      title: 'FileShares · Read — Details of one file or folder',
      description:
        'Type, size, modification time and YOUR effective access for one path on a granted ' +
        'share. Useful before reading or writing.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().min(1).describe('Path from the share root, Unix style.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);

      const stats = await fsStatEntry({ ...target, shareId: str(args.shareId) }, path.path);
      if (!stats.ok) return errText(clientMessage('read that path', stats.err));

      const entry = stats.val;
      const lines = [
        `${entry.path} on "${entry.share.name}"`,
        `Type: ${entry.kind === 'dir' ? 'folder' : 'file'}`,
        ...(entry.size !== null ? [`Size: ${entry.size} bytes`] : []),
        ...(entry.modifiedAt ? [`Modified: ${entry.modifiedAt}`] : []),
        `Your access: ${
          entry.access === 'traverse'
            ? 'traverse only (folders below are granted)'
            : accessWord(entry.access)
        }`,
      ];
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'fileshare_read_file',
    {
      title: 'FileShares · Read — Read a file as text',
      description:
        'Fetch a file from a granted share and return its text — plain files decoded ' +
        'directly, documents (pdf, docx, xlsx, pptx, html) through text extraction. For the ' +
        'raw bytes use fileshare_download_file instead.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().min(1).describe('File path from the share root, Unix style.'),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Cap on returned characters (default 60000).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);

      const maxBytes = Math.min(
        DEFAULT_MAX_INPUT_BYTES,
        context.maxAttachmentBytes ?? DEFAULT_MAX_INPUT_BYTES
      );
      const content = await fsReadFile(
        { ...target, shareId: str(args.shareId) },
        path.path,
        maxBytes
      );
      if (!content.ok) return errText(clientMessage('read the file', content.err));

      const fileName = path.path.slice(path.path.lastIndexOf('/') + 1);
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 60_000;
      const extracted = await extractText(content.val, { fileName, maxChars });
      if (!extracted.ok) {
        return errText(
          extracted.err.type === 'UNSUPPORTED_FORMAT'
            ? `"${fileName}" is not a text-extractable format — fileshare_download_file serves the raw bytes.`
            : `Could not extract text from "${fileName}" (${extracted.err.type}).`
        );
      }
      const notes = extracted.val.notes.length ? `\n[note: ${extracted.val.notes.join('; ')}]` : '';
      return textResult(`${extracted.val.text}${notes}`);
    }
  );

  server.registerTool(
    'fileshare_download_file',
    {
      title: 'FileShares · Read — Get a download link for the raw file',
      description:
        "A link to the file's exact bytes, for when the original file is needed rather " +
        'than its text. The link is served by Renkei and requires being signed in to this ' +
        'Renkei org in the browser — it is not an anonymous URL.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().min(1).describe('File path from the share root, Unix style.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);

      const stats = await fsStatEntry({ ...target, shareId: str(args.shareId) }, path.path);
      if (!stats.ok) return errText(clientMessage('find the file', stats.err));
      if (stats.val.kind === 'dir') {
        return errText(
          `"${path.path}" is a folder — download its files individually ` +
            '(fileshare_list_folder shows what is inside).'
        );
      }

      const base = context.origin;
      if (!base) return errText('This deployment has no public URL configured for links.');
      const url = `${base}/api/tenant/${context.tenantId}/fileshares/${stats.val.share.id}/file?path=${encodeURIComponent(path.path)}`;
      return textResult(
        `Download link for "${path.path}" (${stats.val.size ?? 'unknown'} bytes):\n${url}\n` +
          'Opening it requires being signed in to this Renkei org in the browser; access is ' +
          're-checked at download time.'
      );
    }
  );

  server.registerTool(
    'fileshare_request_file_upload',
    {
      title: 'FileShares · Act — Request an upload slot for a file',
      description:
        'Start writing a file to a granted share (requires read/write on the destination). ' +
        'Returns an upload endpoint; send the raw bytes there (curl with the Authorization ' +
        'header, or the browser link), then confirm with check_file_upload. File content ' +
        'never travels through tool arguments.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z
          .string()
          .describe('Destination FOLDER from the share root, Unix style (e.g. /reports).'),
        filename: z.string().min(1).max(255).describe('Name for the new file.'),
        contentType: z.string().optional().describe('MIME type, if known.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      // The one Act tool that stays store-side: minting a slot writes no
      // bytes, so it checks the ACL context directly for an early, clear
      // refusal — the worker re-runs the full check when the bytes arrive.
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const folder = inputPath(args.path ?? '/');
      if (!folder.ok) return errText(folder.error);

      const filename = str(args.filename).trim();
      if (!filename || filename.includes('/') || filename.includes('\\') || filename === '..') {
        return errText('The filename must be a plain name with no path separators.');
      }
      const destination = childPath(folder.path, filename);
      if (effectiveAccess(resolved.ctx, destination) !== 'read_write') {
        return errText('You do not have read/write access at that destination.');
      }

      const slot = await createUploadSlot(
        context,
        'fileshare-file',
        { shareId: resolved.ctx.share.id, path: folder.path },
        {
          filename,
          contentType: str(args.contentType) || undefined,
          maxBytes: context.maxAttachmentBytes,
        }
      );
      if (!slot.ok) return errText(slot.error);
      return textResult(slot.instructions);
    }
  );

  server.registerTool(
    'fileshare_create_folder',
    {
      title: 'FileShares · Act — Create a folder',
      description:
        'Create a new folder on a granted share (requires read/write on the parent folder).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().min(1).describe('Path of the folder to create, Unix style.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);
      if (path.path === '/') return errText('The share root already exists.');

      const made = await fsMakeFolder({ ...target, shareId: str(args.shareId) }, path.path);
      if (!made.ok) {
        return made.err.kind === 'op' && made.err.type === 'exists'
          ? errText(`"${path.path}" already exists.`)
          : errText(clientMessage('create the folder', made.err));
      }
      return textResult(`Created ${made.val.path} on "${made.val.share.name}".`);
    }
  );

  server.registerTool(
    'fileshare_move_entry',
    {
      title: 'FileShares · Act — Move a file or folder',
      description:
        'Move a file or folder to another folder on the SAME share, keeping its name ' +
        '(requires read/write on both the source and the destination; use ' +
        'fileshare_rename_entry to change the name). Never overwrites: an existing ' +
        'destination is refused.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().min(1).describe('The file or folder to move, Unix style.'),
        toFolder: z.string().describe('Destination FOLDER path, Unix style (e.g. /archive).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const source = inputPath(args.path);
      if (!source.ok) return errText(source.error);
      if (source.path === '/') return errText('The share root cannot be moved.');
      const toFolder = inputPath(args.toFolder ?? '/');
      if (!toFolder.ok) return errText(toFolder.error);

      const moved = await fsMoveEntry(
        { ...target, shareId: str(args.shareId) },
        source.path,
        toFolder.path
      );
      if (!moved.ok) return errText(clientMessage('move it', moved.err));
      if (moved.val.unchanged) return errText('That is already where it lives.');
      return textResult(
        `Moved ${source.path} to ${moved.val.path} on "${moved.val.share.name}".`
      );
    }
  );

  server.registerTool(
    'fileshare_rename_entry',
    {
      title: 'FileShares · Act — Rename a file or folder',
      description:
        'Give a file or folder a new name in its current folder (requires read/write on ' +
        'both the old and new paths). Never overwrites: an existing name is refused. To ' +
        'change folders, use fileshare_move_entry.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().min(1).describe('The file or folder to rename, Unix style.'),
        newName: z.string().min(1).max(255).describe('The new name (no path separators).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const source = inputPath(args.path);
      if (!source.ok) return errText(source.error);
      if (source.path === '/') return errText('The share root cannot be renamed.');

      const renamed = await fsRenameEntry(
        { ...target, shareId: str(args.shareId) },
        source.path,
        str(args.newName)
      );
      if (!renamed.ok) return errText(clientMessage('rename it', renamed.err));
      if (renamed.val.unchanged) return errText('That is already its name.');
      return textResult(
        `Renamed ${source.path} to ${renamed.val.path} on "${renamed.val.share.name}".`
      );
    }
  );

  /*
    Deletion is preview + confirm only (the outlook_cancel_event shape):
    file-server deletes have no recycle bin, so the card puts a human click
    between the model and the irreversible act. Both registrations delete
    through the worker's single delete operation — the confirm path IS the
    delete path, and the worker re-runs every check itself rather than
    trusting anything the card sends.
  */
  const deleteEntrySchema = z.object({
    shareId: z.string().uuid().describe('From fileshare_list_shares.'),
    path: z.string().min(1).describe('The file or empty folder to delete, Unix style.'),
  });

  const deleteEntryHandler = async (args: Record<string, unknown>) => {
    const target = auth.target();
    if (typeof target === 'string') return errText(target);
    const path = inputPath(args.path);
    if (!path.ok) return errText(path.error);
    if (path.path === '/') return errText('The share root cannot be deleted.');

    const removed = await fsRemoveEntry({ ...target, shareId: str(args.shareId) }, path.path);
    if (!removed.ok) return errText(clientMessage('delete it', removed.err));
    return textResult(`Deleted ${removed.val.path} from "${removed.val.share.name}".`);
  };

  const previewGuidance = (what: string) =>
    `${what} is awaiting the user's decision on the preview card. Do not write it another ` +
    `way and do not repeat its contents in your reply; the user confirms or cancels from ` +
    `the card. If no card appeared in this client, ask the user how to proceed.`;

  server.registerTool(
    'fileshare_delete_entry_preview',
    {
      title: 'FileShares · Act — Preview a deletion before it happens',
      description:
        'Show the user an interactive card to confirm or cancel deleting a file or EMPTY ' +
        'folder from a granted share. This is the only way to delete here — file-server ' +
        'deletion is permanent, so the user decides on the card. Requires read/write on ' +
        'the path.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: deleteEntrySchema,
    },
    async (args: Record<string, unknown>) => {
      const target = auth.target();
      if (typeof target === 'string') return errText(target);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);
      if (path.path === '/') return errText('The share root cannot be deleted.');

      // Read-only enrichment: what exactly is on the card. The worker runs
      // the same gates the delete will, plus a non-empty-folder refusal —
      // the card must never promise a deletion the confirm path would
      // refuse.
      const looked = await fsPreviewRemove({ ...target, shareId: str(args.shareId) }, path.path);
      if (!looked.ok) return errText(clientMessage('delete it', looked.err));
      const entry = looked.val;

      const name = path.path.slice(path.path.lastIndexOf('/') + 1);
      return {
        content: [{ type: 'text' as const, text: previewGuidance(`The deletion of ${path.path}`) }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Delete ${name} permanently`,
          subtitle: `${entry.share.name} · ${path.path}`,
          confirmTool: 'fileshare_delete_entry_confirm',
          confirmLabel: 'Delete permanently',
          confirmArgs: args,
          fields: [
            { label: 'Share', value: entry.share.name },
            { label: 'Path', value: path.path },
            { label: 'Type', value: entry.kind === 'dir' ? 'Empty folder' : 'File' },
            ...(entry.size !== null ? [{ label: 'Size', value: `${entry.size} bytes` }] : []),
            ...(entry.modifiedAt ? [{ label: 'Modified', value: entry.modifiedAt }] : []),
            { label: 'Undo', value: 'None — deletion on the file server is permanent' },
          ],
        },
      };
    }
  );

  server.registerTool(
    'fileshare_delete_entry_confirm',
    {
      title: 'FileShares · Act — Execute a confirmed deletion',
      description:
        'Delete the file or empty folder the user confirmed on the preview card. ' +
        confirmGuard('fileshare_delete_entry_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: deleteEntrySchema,
    },
    deleteEntryHandler
  );
}
