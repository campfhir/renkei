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
import { extractText, DEFAULT_MAX_INPUT_BYTES } from '@renkei/document-text';
import {
  annotateEntries,
  canListFolder,
  childPath,
  effectiveAccess,
  hasAllowedDescendant,
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
    default:
      return `Could not ${what}: ${error.message ?? error.type}.`;
  }
}
