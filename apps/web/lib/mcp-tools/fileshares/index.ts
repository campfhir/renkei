/**
 * The fileshare_* tools — org-registered SMB/SFTP shares where Renkei's own
 * grant/rule store is the ACL authority (there is no provider to delegate
 * to: the backend connection uses one admin-held service credential).
 *
 * Two rules carried through every handler:
 *
 *  - Enforcement happens here, per call, through the pure ACL engine over a
 *    freshly-resolved context. The capability gate only decides whether the
 *    tools exist for a caller; it cannot substitute for the per-path check.
 *  - Every path a model supplies is normalized before use, and a traversal
 *    spelling is a refusal with a reason, never a resolution. The backends
 *    re-verify containment again below — but this boundary is the one that
 *    can phrase the refusal for the model.
 *
 * No scope gate: fileshares has no OAuth scopes (the cards/agents
 * precedent), so registration wraps only the capability gate the registry
 * applies. Listings annotate every entry with the caller's own permission,
 * because "what may I do here" is the question a model asks next.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { extractText, DEFAULT_MAX_INPUT_BYTES } from '@renkei/document-text';
import {
  annotateEntries,
  canListFolder,
  childPath,
  effectiveAccess,
  hasAllowedDescendant,
  listRulePathsUnder,
  normalizePath,
  openBackend,
  parentPath,
  withSessionLimits,
} from '@renkei/connector-fileshares';
import type {
  AccessLevel,
  BackendError,
  GrantedShare,
  ShareBackend,
  ShareEntry,
} from '@renkei/connector-fileshares';
import type { Result } from '@campfhir/safe-functions/types';
import type { MCPToolContext } from '../common';
import { createUploadSlot } from '../upload-slots';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import type { FileshareAuth, ResolvedShare } from './fileshare-auth';

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

function entryLine(entry: ShareEntry): string {
  const marker = entry.access === 'traverse' ? '[folders below]' : `[${accessWord(entry.access)}]`;
  if (entry.kind === 'dir') return `${entry.path}/ ${marker}`;
  const size = entry.size !== null ? ` · ${entry.size} bytes` : '';
  const when = entry.modifiedAt ? ` · modified ${entry.modifiedAt.toISOString()}` : '';
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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const path = inputPath(args.path ?? '/');
      if (!path.ok) return errText(path.error);

      if (!canListFolder(resolved.ctx, path.path)) {
        return errText('You do not have access to that folder.');
      }

      const listed = await withShareSession(resolved, (backend) => backend.list(path.path));
      if (!listed.ok) return errText(backendMessage('list the folder', listed.err));

      const visible = annotateEntries(resolved.ctx, path.path, listed.val);
      if (visible.length === 0) {
        return textResult(`${path.path} has no entries you can access.`);
      }
      return textResult(
        `${path.path} on "${resolved.ctx.share.name}":\n` +
          visible.map((entry) => entryLine(entry)).join('\n')
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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);

      const access = effectiveAccess(resolved.ctx, path.path);
      const traversable = access === 'none' && hasAllowedDescendant(resolved.ctx, path.path);
      if (access === 'none' && !traversable) {
        return errText('You do not have access to that path.');
      }

      const stats = await withShareSession(resolved, (backend) => backend.stat(path.path));
      if (!stats.ok) return errText(backendMessage('read that path', stats.err));

      const lines = [
        `${path.path} on "${resolved.ctx.share.name}"`,
        `Type: ${stats.val.kind === 'dir' ? 'folder' : 'file'}`,
        ...(stats.val.size !== null ? [`Size: ${stats.val.size} bytes`] : []),
        ...(stats.val.modifiedAt ? [`Modified: ${stats.val.modifiedAt.toISOString()}`] : []),
        `Your access: ${traversable ? 'traverse only (folders below are granted)' : accessWord(access)}`,
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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);

      if (effectiveAccess(resolved.ctx, path.path) === 'none') {
        return errText('You do not have access to that file.');
      }

      const maxBytes = Math.min(
        DEFAULT_MAX_INPUT_BYTES,
        context.maxAttachmentBytes ?? DEFAULT_MAX_INPUT_BYTES
      );
      const content = await withShareSession(resolved, (backend) =>
        backend.read(path.path, maxBytes)
      );
      if (!content.ok) return errText(backendMessage('read the file', content.err));

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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);

      if (effectiveAccess(resolved.ctx, path.path) === 'none') {
        return errText('You do not have access to that file.');
      }

      const stats = await withShareSession(resolved, (backend) => backend.stat(path.path));
      if (!stats.ok) return errText(backendMessage('find the file', stats.err));
      if (stats.val.kind === 'dir') {
        return errText(
          `"${path.path}" is a folder — download its files individually ` +
            '(fileshare_list_folder shows what is inside).'
        );
      }

      const base = context.origin;
      if (!base) return errText('This deployment has no public URL configured for links.');
      const url = `${base}/api/tenant/${context.tenantId}/fileshares/${resolved.ctx.share.id}/file?path=${encodeURIComponent(path.path)}`;
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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);
      if (path.path === '/') return errText('The share root already exists.');

      if (effectiveAccess(resolved.ctx, parentPath(path.path)) !== 'read_write') {
        return errText('You do not have read/write access in the parent folder.');
      }

      const made = await withShareSession(resolved, (backend) => backend.mkdir(path.path));
      if (!made.ok) {
        return made.err.type === 'exists'
          ? errText(`"${path.path}" already exists.`)
          : errText(backendMessage('create the folder', made.err));
      }
      return textResult(`Created ${path.path} on "${resolved.ctx.share.name}".`);
    }
  );

  /**
   * The destructive-operation gate, shared by move, rename and delete:
   * read/write on the target, and NO rule — any layer, ANY subject —
   * anchored at or under it. Rules govern paths, not objects; a rename
   * that slid ruled content to an unruled path would be an ACL bypass, so
   * anchored content stays put until an admin removes the rules. Errors
   * fail closed, and the refusal names the anchored paths so the admin
   * knows what to clear.
   */
  async function destructiveRefusal(
    resolved: ResolvedShare,
    path: string,
    verb: string
  ): Promise<string | null> {
    if (effectiveAccess(resolved.ctx, path) !== 'read_write') {
      return `You do not have read/write access to ${verb} that path.`;
    }
    const dbResult = getDatabase();
    if (!dbResult.ok) return 'Database unavailable.';
    const anchored = await listRulePathsUnder(
      dbResult.val,
      context.tenantId,
      resolved.ctx.share.id,
      path,
      resolved.ctx.share.caseInsensitive
    );
    if (!anchored.ok) return 'Could not verify the path rules here.';
    if (anchored.val.length > 0) {
      return (
        `Access rules are anchored at or under that path (${anchored.val.join(', ')}), so it ` +
        `cannot be ${verb === 'delete' ? 'deleted' : 'moved or renamed'} — an administrator ` +
        'must remove those rules first.'
      );
    }
    return null;
  }

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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const source = inputPath(args.path);
      if (!source.ok) return errText(source.error);
      if (source.path === '/') return errText('The share root cannot be moved.');
      const toFolder = inputPath(args.toFolder ?? '/');
      if (!toFolder.ok) return errText(toFolder.error);

      const name = source.path.slice(source.path.lastIndexOf('/') + 1);
      const destination = childPath(toFolder.path, name);
      if (destination === source.path) return errText('That is already where it lives.');

      const refusal = await destructiveRefusal(resolved, source.path, 'move');
      if (refusal) return errText(refusal);
      if (effectiveAccess(resolved.ctx, destination) !== 'read_write') {
        return errText('You do not have read/write access at the destination.');
      }

      const renamed = await withShareSession(resolved, (backend) =>
        backend.rename(source.path, destination)
      );
      if (!renamed.ok) return errText(backendMessage('move it', renamed.err));
      return textResult(`Moved ${source.path} to ${destination} on "${resolved.ctx.share.name}".`);
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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const source = inputPath(args.path);
      if (!source.ok) return errText(source.error);
      if (source.path === '/') return errText('The share root cannot be renamed.');

      const newName = str(args.newName).trim();
      if (!newName || newName.includes('/') || newName.includes('\\') || newName === '..') {
        return errText('The new name must be a plain name with no path separators.');
      }
      const destination = childPath(parentPath(source.path), newName);
      if (destination === source.path) return errText('That is already its name.');

      const refusal = await destructiveRefusal(resolved, source.path, 'rename');
      if (refusal) return errText(refusal);
      if (effectiveAccess(resolved.ctx, destination) !== 'read_write') {
        return errText('You do not have read/write access at the new name.');
      }

      const renamed = await withShareSession(resolved, (backend) =>
        backend.rename(source.path, destination)
      );
      if (!renamed.ok) return errText(backendMessage('rename it', renamed.err));
      return textResult(
        `Renamed ${source.path} to ${destination} on "${resolved.ctx.share.name}".`
      );
    }
  );

  /*
    Deletion is preview + confirm only (the outlook_cancel_event shape):
    file-server deletes have no recycle bin, so the card puts a human click
    between the model and the irreversible act. One schema and one handler
    serve both registrations — the confirm path IS the delete path, and it
    re-runs every check itself rather than trusting anything the card sends.
  */
  const deleteEntrySchema = z.object({
    shareId: z.string().uuid().describe('From fileshare_list_shares.'),
    path: z.string().min(1).describe('The file or empty folder to delete, Unix style.'),
  });

  const deleteEntryHandler = async (args: Record<string, unknown>) => {
    const resolved = await auth.resolve(str(args.shareId));
    if (typeof resolved === 'string') return errText(resolved);
    const path = inputPath(args.path);
    if (!path.ok) return errText(path.error);
    if (path.path === '/') return errText('The share root cannot be deleted.');

    const refusal = await destructiveRefusal(resolved, path.path, 'delete');
    if (refusal) return errText(refusal);

    const removed = await withShareSession(resolved, async (backend) => {
      const stats = await backend.stat(path.path);
      if (!stats.ok) return stats;
      return backend.remove(path.path, stats.val.kind);
    });
    if (!removed.ok) return errText(backendMessage('delete it', removed.err));
    return textResult(`Deleted ${path.path} from "${resolved.ctx.share.name}".`);
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
      const resolved = await auth.resolve(str(args.shareId));
      if (typeof resolved === 'string') return errText(resolved);
      const path = inputPath(args.path);
      if (!path.ok) return errText(path.error);
      if (path.path === '/') return errText('The share root cannot be deleted.');

      const refusal = await destructiveRefusal(resolved, path.path, 'delete');
      if (refusal) return errText(refusal);

      // Read-only enrichment: what exactly is on the card. A non-empty
      // folder is refused here rather than at confirm time — the card must
      // never promise a deletion the confirm path would refuse.
      const looked = await withShareSession(resolved, async (backend) => {
        const stats = await backend.stat(path.path);
        if (!stats.ok) return stats;
        if (stats.val.kind === 'dir') {
          const children = await backend.list(path.path);
          if (!children.ok) return children;
          if (children.val.length > 0) {
            return {
              ok: false as const,
              val: undefined,
              err: { type: 'not_empty' as const, message: undefined },
            };
          }
        }
        return { ok: true as const, val: stats.val };
      });
      if (!looked.ok) return errText(backendMessage('delete it', looked.err));
      const entry = looked.val;

      const name = path.path.slice(path.path.lastIndexOf('/') + 1);
      return {
        content: [{ type: 'text' as const, text: previewGuidance(`The deletion of ${path.path}`) }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Delete ${name} permanently`,
          subtitle: `${resolved.ctx.share.name} · ${path.path}`,
          confirmTool: 'fileshare_delete_entry_confirm',
          confirmLabel: 'Delete permanently',
          confirmArgs: args,
          fields: [
            { label: 'Share', value: resolved.ctx.share.name },
            { label: 'Path', value: path.path },
            { label: 'Type', value: entry.kind === 'dir' ? 'Empty folder' : 'File' },
            ...(entry.size !== null ? [{ label: 'Size', value: `${entry.size} bytes` }] : []),
            ...(entry.modifiedAt
              ? [{ label: 'Modified', value: entry.modifiedAt.toISOString() }]
              : []),
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

/** One bounded backend session: open, run, always close. */
async function withShareSession<T>(
  resolved: ResolvedShare,
  work: (backend: ShareBackend) => Promise<Result<T, BackendError>>
): Promise<Result<T, BackendError>> {
  return withSessionLimits(resolved.ctx.share.id, 'interactive', async () => {
    const opened = await openBackend(resolved.ctx.share, resolved.credentials);
    if (!opened.ok) return opened;
    try {
      return await work(opened.val);
    } finally {
      await opened.val.close();
    }
  });
}

function backendMessage(what: string, error: { type: string; message?: string }): string {
  switch (error.type) {
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
