/**
 * The document, folder, metadata and sharing tools — registered under BOTH
 * the SharePoint and OneDrive namespaces.
 *
 * They share one implementation because they are one API: a OneDrive is a
 * drive and a SharePoint document library is a drive, and once /me/drive has
 * been resolved to an id the calls are identical. What differs is the naming
 * a person expects and which scopes gate it, so each namespace supplies a
 * prefix, a title word, and how to find its default drive.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from './graph-auth';
import { withPresentationHint } from '../common';
import {
  graphGet,
  graphPost,
  graphPatch,
  graphDelete,
  graphPutContent,
  values,
  str,
  num,
  rec,
  textResult,
  errText,
  byteSize,
} from './client';
import { graphDownload } from '@renkei/connector-microsoft';
import { extractText } from '@renkei/document-text';
import { logger } from '@/lib/logger';
import { resolveDriveItem, resolveMyDriveId, type ItemSelector } from './resolve';

export interface NamespaceOptions {
  /** 'sharepoint' | 'onedrive' */
  prefix: string;
  /** 'SharePoint' | 'OneDrive' — the title word. */
  title: string;
  /** OneDrive resolves /me/drive; SharePoint requires an explicit site. */
  usesMyDrive: boolean;
}

/** The selector fields every document tool accepts. See resolve.ts for why. */
function selectorSchema(options: NamespaceOptions): Record<string, z.ZodTypeAny> {
  const base: Record<string, z.ZodTypeAny> = {
    itemUrl: z
      .string()
      .describe('A pasted SharePoint/OneDrive link to the file or folder. The easiest option.')
      .optional(),
    driveId: z
      .string()
      .describe('Drive id, echoed by listings and searches. Pair with itemId or path.')
      .optional(),
    itemId: z
      .string()
      .describe('Item id, echoed by listings and searches. Pair it with that driveId.')
      .optional(),
    path: z
      .string()
      .describe('Slash-separated path inside the drive, e.g. "Specs/2026/plan.docx".')
      .optional(),
  };
  if (!options.usesMyDrive) {
    base.site = z
      .string()
      .describe('Site URL or id. Use with library+path to name a document the human way.')
      .optional();
    base.library = z
      .string()
      .describe('Document library name; omit for the site default.')
      .optional();
  }
  return base;
}

function selectorOf(args: Record<string, unknown>): ItemSelector {
  return {
    itemUrl: str(args.itemUrl) || undefined,
    driveId: str(args.driveId) || undefined,
    itemId: str(args.itemId) || undefined,
    path: str(args.path) || undefined,
    site: str(args.site) || undefined,
    library: str(args.library) || undefined,
  };
}

/** parentReference.path → a human path ("/Specs/2026"), or '' when absent. */
export function folderPathOf(entry: Record<string, unknown>): string {
  const raw = str(rec(entry.parentReference).path);
  if (!raw) return '';
  return (
    decodeURIComponent(
      raw.replace(/^\/drives\/[^/]+\/root:?/, '').replace(/^\/drive\/root:?/, '')
    ) || '/'
  );
}

/**
 * One line per child in a listing. The id is labelled `itemId` — the exact
 * parameter name the other tools take — because a listing whose labels do
 * not match the parameters makes the follow-up call a guessing game.
 */
function itemLine(entry: Record<string, unknown>): string {
  const isFolder = entry.folder !== undefined;
  const size = byteSize(num(entry.size));
  const modified = str(entry.lastModifiedDateTime).slice(0, 10);
  const by = str(rec(rec(entry.lastModifiedBy).user).displayName);
  const location = folderPathOf(entry);
  const bits = [size, modified && `modified ${modified}`, by && `by ${by}`].filter(Boolean);
  return (
    `${isFolder ? '📁' : '📄'} ${str(entry.name)}${bits.length ? ` — ${bits.join(', ')}` : ''}` +
    (location ? `\n    in ${location}` : '') +
    `\n    itemId: ${str(entry.id)}`
  );
}

function permissionLine(entry: Record<string, unknown>): string {
  const roles = Array.isArray(entry.roles) ? entry.roles.join('/') : '';
  const invitation = rec(entry.invitation);
  const link = rec(entry.link);
  const granted = rec(entry.grantedToV2);
  const who =
    str(rec(granted.user).displayName) ||
    str(rec(granted.siteGroup).displayName) ||
    str(invitation.email) ||
    (link.scope ? `${str(link.scope)} link` : '') ||
    'unknown';
  return `${who} — ${roles || 'no role'}${link.webUrl ? `\n    ${str(link.webUrl)}` : ''}\n    permission id: ${str(entry.id)}`;
}

/**
 * Resolve the drive a namespace works in when the caller gave no explicit
 * one. OneDrive has an obvious answer; SharePoint does not, and guessing
 * would silently act on the wrong library.
 */
async function defaultDriveFor(
  options: NamespaceOptions,
  context: MCPToolContext,
  token: string
): Promise<string | undefined> {
  if (!options.usesMyDrive) return undefined;
  const mine = await resolveMyDriveId(context, token);
  return mine.ok ? mine.driveId : undefined;
}

export function registerDocumentTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GraphAuth,
  options: NamespaceOptions
): void {
  const { prefix, title } = options;
  const selector = selectorSchema(options);

  server.registerTool(
    `${prefix}_list_folder`,
    {
      title: `${title} · Read — List what is in a folder`,
      description:
        `Files and folders inside a ${title} folder, newest first. Omit every selector to ` +
        `list the root. Each entry carries the itemId — and the header the driveId — that ` +
        `the other ${prefix}_* tools take.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        ...selector,
        max: z.number().int().min(1).max(200).describe('How many (default 50).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const max = num(args.max) ?? 50;
      const listing = await graphGet(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}/children` +
          `?$top=${max}&$orderby=lastModifiedDateTime desc` +
          '&$select=id,name,size,folder,file,webUrl,lastModifiedDateTime,lastModifiedBy'
      );
      if (!listing.ok) return errText(listing.error);

      const entries = values(listing.body);
      if (entries.length === 0)
        return textResult(`${resolved.item.name || 'That folder'} is empty.`);
      return textResult(
        withPresentationHint(
          `${resolved.item.name || 'Root'} — ${entries.length} item(s)\n` +
            `driveId: ${resolved.item.driveId} (pair it with an itemId below in other ${prefix}_* calls)\n\n` +
            entries.map(itemLine).join('\n'),
          'Render as a list; folders first.'
        )
      );
    }
  );

  server.registerTool(
    `${prefix}_get_document`,
    {
      title: `${title} · Read — Get a document's details`,
      description: `Size, who changed it last, and its link — without reading the contents.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object(selector),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const item = await graphGet(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}` +
          '?$select=id,name,size,file,folder,webUrl,createdBy,lastModifiedBy,lastModifiedDateTime,createdDateTime'
      );
      if (!item.ok) return errText(item.error);

      const body = item.body;
      const lines = [
        `Name: ${str(body.name)}`,
        `Type: ${body.folder !== undefined ? 'folder' : str(rec(body.file).mimeType) || 'file'}`,
        `Size: ${byteSize(num(body.size)) || 'unknown'}`,
        `Created: ${str(body.createdDateTime).slice(0, 10)} by ${str(rec(rec(body.createdBy).user).displayName)}`,
        `Modified: ${str(body.lastModifiedDateTime).slice(0, 10)} by ${str(rec(rec(body.lastModifiedBy).user).displayName)}`,
        `Link: ${str(body.webUrl)}`,
        `driveId: ${resolved.item.driveId}`,
        `itemId: ${str(body.id)}`,
      ];
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    `${prefix}_read_document`,
    {
      title: `${title} · Read — Read a document's text`,
      description:
        `The text inside a document — Word, Excel, PowerPoint, PDF, or plain text — ready to ` +
        `quote or summarize. Spreadsheets come back as labelled rows and decks include speaker ` +
        `notes. Scanned PDFs have no text layer and are reported as such rather than returning ` +
        `nothing: there is no OCR here.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        ...selector,
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .describe('Cap the returned text (default 60000).')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const downloaded = await graphDownload(
        access.accessToken,
        resolved.item.driveId,
        resolved.item.itemId,
        // Someone asked for this file and is waiting; it must not queue
        // behind a library re-index.
        { lane: 'interactive' }
      );
      if (!downloaded.ok) {
        return errText(
          downloaded.err.type === 'CONTENT_TOO_LARGE'
            ? `"${resolved.item.name}" is too large to read here.`
            : `Could not download "${resolved.item.name}".`
        );
      }

      const extracted = await extractText(downloaded.val.bytes, {
        fileName: resolved.item.name,
        contentType: downloaded.val.contentType ?? undefined,
        maxChars: num(args.maxChars) ?? 60_000,
      });
      if (!extracted.ok) {
        // A broken PDF backend is the one failure here that is NOT about the
        // file, and saying otherwise sends the reader off to fix a document
        // that was never the problem. Blaming the deployment out loud is also
        // the only way the person who can fix it ever hears about it.
        if (extracted.err.type === 'PDF_BACKEND_UNAVAILABLE') {
          logger.error('PDF extraction backend unavailable: {reason}', {
            component: 'graph/documents',
            tenantId: context.tenantId,
            subject: context.subject,
            reason: extracted.err.message,
          });
          return textResult(
            `Cannot read "${resolved.item.name}" — PDF support is not working on this Renkei ` +
              `deployment, so no PDF can be read right now. This is a server-side fault, not a ` +
              `problem with the document; report it to whoever runs Renkei. Nothing about the ` +
              `file needs changing.\nLink: ${resolved.item.webUrl}`
          );
        }
        // Each of the rest is a fact about the file, not a failure of the
        // tool, so the model is told which one rather than "something went
        // wrong".
        const because: Record<string, string> = {
          UNSUPPORTED_FORMAT: 'its format cannot be read as text',
          ENCRYPTED: 'it is password protected',
          CORRUPT: 'the file appears to be damaged',
          EMPTY: 'it contains no text',
          INPUT_TOO_LARGE: 'it is too large',
          EXTRACTION_FAILED: 'the text could not be extracted',
        };
        return textResult(
          `Cannot read "${resolved.item.name}" — ${because[extracted.err.type] ?? 'unknown reason'}.\n` +
            `Link: ${resolved.item.webUrl}`
        );
      }

      if (extracted.val.notes.includes('scanned-pdf')) {
        return textResult(
          `"${resolved.item.name}" looks like a scan — its pages carry no text layer, and there ` +
            `is no OCR here.\nLink: ${resolved.item.webUrl}`
        );
      }

      const header = `${resolved.item.name}${extracted.val.sections ? ` (${extracted.val.sections} section(s))` : ''}`;
      const footer = extracted.val.truncated ? '\n\n[Text truncated.]' : '';
      return textResult(
        withPresentationHint(
          `${header}\n\n${extracted.val.text}${footer}`,
          'Render as the document text; summarize it if that is what was asked.'
        )
      );
    }
  );

  server.registerTool(
    `${prefix}_download_document`,
    {
      title: `${title} · Read — Get a download link for the raw file`,
      description:
        `A short-lived link to the file's exact bytes — for when the original file is needed, ` +
        `not its text (comparing versions, feeding another system, images, archives). The link ` +
        `is pre-authenticated: a plain HTTP GET with no headers fetches it, from curl, a ` +
        `browser, or any HTTP tool. It expires after about an hour; call again for a fresh ` +
        `one. To read a document's text instead, use ${prefix}_read_document.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object(selector),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const item = await graphGet(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}` +
          '?$select=id,name,size,file,folder,webUrl,@microsoft.graph.downloadUrl'
      );
      if (!item.ok) return errText(item.error);

      const body = item.body;
      if (body.folder !== undefined) {
        return errText(
          `"${resolved.item.name}" is a folder — download its files individually ` +
            `(${prefix}_list_folder shows what is inside).`
        );
      }
      const downloadUrl = str(body['@microsoft.graph.downloadUrl']);
      if (!downloadUrl) {
        return errText(`Graph offered no download link for "${resolved.item.name}".`);
      }
      return textResult(
        [
          `${str(body.name)} — ${byteSize(num(body.size)) || 'unknown size'}` +
            `${str(rec(body.file).mimeType) ? ` (${str(rec(body.file).mimeType)})` : ''}`,
          '',
          'Download link (pre-authenticated, no headers needed, expires in about an hour):',
          downloadUrl,
          '',
          `driveId: ${resolved.item.driveId}`,
          `itemId: ${str(body.id)}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    `${prefix}_search_documents`,
    {
      title: `${title} · Read — Search for documents by name or content`,
      description:
        `Search ${title} for documents matching a query. Searches file names and, where ` +
        'the service has indexed them, contents. Each hit carries its location and itemId; ' +
        'the header carries the driveId to pair it with in the other tools.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('What to search for.'),
        ...(options.usesMyDrive
          ? {}
          : {
              site: z.string().describe('Restrict to one site.').optional(),
              library: z.string().describe('Restrict to one library.').optional(),
            }),
        driveId: z.string().describe('Restrict to one drive.').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      let driveId = str(args.driveId);
      if (!driveId) {
        const fallback = await defaultDriveFor(options, context, access.accessToken);
        driveId = fallback ?? '';
      }
      if (!driveId && str(args.site)) {
        const resolved = await resolveDriveItem(
          context,
          access.accessToken,
          { site: str(args.site), library: str(args.library) || undefined },
          undefined
        );
        if (!resolved.ok) return errText(resolved.error);
        driveId = resolved.item.driveId;
      }
      if (!driveId) {
        return errText('Give a site (or a driveId) to search within.');
      }

      const max = num(args.max) ?? 25;
      const query = encodeURIComponent(String(args.query).replace(/'/g, "''"));
      const found = await graphGet(
        context,
        access.accessToken,
        `/drives/${driveId}/root/search(q='${query}')?$top=${max}` +
          '&$select=id,name,size,folder,file,webUrl,lastModifiedDateTime,parentReference'
      );
      if (!found.ok) return errText(found.error);

      const entries = values(found.body);
      if (entries.length === 0) return textResult(`Nothing in ${title} matched "${args.query}".`);
      return textResult(
        withPresentationHint(
          `${entries.length} match(es) for "${args.query}"\n` +
            `driveId: ${driveId} (pair it with an itemId below in other ${prefix}_* calls)\n\n` +
            entries.map(itemLine).join('\n'),
          'Render as a list of results.'
        )
      );
    }
  );

  server.registerTool(
    `${prefix}_create_folder`,
    {
      title: `${title} · Act — Create a folder`,
      description: `Create a folder inside another folder. Selectors name the PARENT.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        name: z.string().min(1).describe('Name for the new folder.'),
        ifNameTaken: z
          .enum(['rename', 'replace', 'fail'])
          .describe('What to do when a folder of that name exists (default rename).')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const parent = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!parent.ok) return errText(parent.error);

      const created = await graphPost(
        context,
        access.accessToken,
        `/drives/${parent.item.driveId}/items/${parent.item.itemId}/children`,
        {
          name: String(args.name),
          folder: {},
          '@microsoft.graph.conflictBehavior': str(args.ifNameTaken) || 'rename',
        }
      );
      if (!created.ok) return errText(created.error);
      return textResult(
        `Created folder "${str(created.body.name)}" in ${parent.item.name || 'the root'}.\n` +
          `driveId: ${parent.item.driveId}\nitemId: ${str(created.body.id)}`
      );
    }
  );

  server.registerTool(
    `${prefix}_rename_document`,
    {
      title: `${title} · Act — Rename a document or folder`,
      description: `Change the name of a file or folder. Works on both.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        newName: z.string().min(1).describe('The new name, including extension for files.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const renamed = await graphPatch(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}`,
        { name: String(args.newName) }
      );
      if (!renamed.ok) return errText(renamed.error);
      return textResult(`Renamed "${resolved.item.name}" to "${str(renamed.body.name)}".`);
    }
  );

  server.registerTool(
    `${prefix}_move_document`,
    {
      title: `${title} · Act — Move a document or folder`,
      description:
        `Move a file or folder into another folder in the SAME drive. Graph cannot move ` +
        `across drives — to move a document to a different library or site, use ` +
        `${prefix}_copy_document and then ${prefix}_delete_document.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        destinationFolderId: z.string().describe('Item id of the destination folder.').optional(),
        destinationPath: z.string().describe('Path of the destination folder.').optional(),
        newName: z.string().describe('Optionally rename while moving.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const destination = await resolveDriveItem(
        context,
        access.accessToken,
        {
          driveId: resolved.item.driveId,
          itemId: str(args.destinationFolderId) || undefined,
          path: str(args.destinationPath) || undefined,
        },
        resolved.item.driveId
      );
      if (!destination.ok) return errText(destination.error);
      if (destination.item.driveId !== resolved.item.driveId) {
        return errText(
          `That destination is in a different drive. Graph cannot move across drives — ` +
            `use ${prefix}_copy_document then ${prefix}_delete_document instead.`
        );
      }

      const moved = await graphPatch(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}`,
        {
          parentReference: { id: destination.item.itemId },
          ...(str(args.newName) ? { name: str(args.newName) } : {}),
        }
      );
      if (!moved.ok) return errText(moved.error);
      return textResult(
        `Moved "${resolved.item.name}" into "${destination.item.name || 'the root'}".`
      );
    }
  );

  server.registerTool(
    `${prefix}_copy_document`,
    {
      title: `${title} · Act — Copy a document or folder`,
      description:
        `Copy a file or folder, optionally into a different drive or site. Graph performs ` +
        `copies ASYNCHRONOUSLY: this returns once the copy is accepted, not once it has ` +
        `finished. Re-list the destination folder to confirm.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        destinationDriveId: z
          .string()
          .describe('Destination drive; defaults to the same one.')
          .optional(),
        destinationFolderId: z.string().describe('Item id of the destination folder.').optional(),
        newName: z.string().describe('Name for the copy.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const destinationDriveId = str(args.destinationDriveId) || resolved.item.driveId;
      const destination = await resolveDriveItem(
        context,
        access.accessToken,
        { driveId: destinationDriveId, itemId: str(args.destinationFolderId) || undefined },
        destinationDriveId
      );
      if (!destination.ok) return errText(destination.error);

      const copied = await graphPost(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}/copy`,
        {
          parentReference: { driveId: destination.item.driveId, id: destination.item.itemId },
          ...(str(args.newName) ? { name: str(args.newName) } : {}),
        }
      );
      if (!copied.ok) return errText(copied.error);
      return textResult(
        `Copy of "${resolved.item.name}" queued into "${destination.item.name || 'the root'}". ` +
          `SharePoint completes copies in the background — re-list the destination to confirm.`
      );
    }
  );

  server.registerTool(
    `${prefix}_delete_document`,
    {
      title: `${title} · Act — Delete a document or folder`,
      description:
        `Delete a file or folder. It goes to the recycle bin rather than being destroyed, ` +
        `but Graph offers no way to restore it — recovery is manual, in the ${title} UI. ` +
        `Deleting a folder deletes everything inside it.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object(selector),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const deleted = await graphDelete(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}`
      );
      if (!deleted.ok) return errText(deleted.error);
      return textResult(`Deleted "${resolved.item.name}" (moved to the recycle bin).`);
    }
  );

  server.registerTool(
    `${prefix}_upload_document`,
    {
      title: `${title} · Act — Upload a document`,
      description:
        `Upload a file into a folder. Selectors name the PARENT folder. Content is ` +
        `base64. Files larger than about 4 MB are rejected — those need an upload ` +
        `session, which this tool does not open.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        filename: z.string().min(1).describe('Name for the uploaded file, with extension.'),
        contentBase64: z.string().min(1).describe('File content, base64 encoded.'),
        contentType: z
          .string()
          .describe('MIME type (default application/octet-stream).')
          .optional(),
        ifNameTaken: z
          .enum(['rename', 'replace', 'fail'])
          .describe('What to do when the name exists (default rename).')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const parent = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!parent.ok) return errText(parent.error);

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(String(args.contentBase64), 'base64'));
      } catch {
        return errText('contentBase64 is not valid base64.');
      }
      // The simple upload endpoint's own ceiling; past it Graph requires an
      // upload session, and silently truncating would be far worse.
      if (bytes.byteLength > 4 * 1024 * 1024) {
        return errText(
          `That file is ${byteSize(bytes.byteLength)}. Simple upload tops out at 4 MB.`
        );
      }

      const name = encodeURIComponent(String(args.filename));
      const conflict = str(args.ifNameTaken) || 'rename';
      const uploaded = await graphPutContent(
        context,
        access.accessToken,
        `/drives/${parent.item.driveId}/items/${parent.item.itemId}:/${name}:/content` +
          `?@microsoft.graph.conflictBehavior=${conflict}`,
        bytes,
        str(args.contentType) || 'application/octet-stream'
      );
      if (!uploaded.ok) return errText(uploaded.error);
      return textResult(
        `Uploaded "${str(uploaded.body.name) || String(args.filename)}" ` +
          `(${byteSize(bytes.byteLength)}) to ${parent.item.name || 'the root'}.\n` +
          `driveId: ${parent.item.driveId}\nitemId: ${str(uploaded.body.id)}`
      );
    }
  );

  // ——— sharing ———

  server.registerTool(
    `${prefix}_list_document_access`,
    {
      title: `${title} · Read — See who can reach a document`,
      description: `Everyone and every link that currently grants access to a file or folder.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object(selector),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const permissions = await graphGet(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}/permissions`
      );
      if (!permissions.ok) return errText(permissions.error);

      const entries = values(permissions.body);
      if (entries.length === 0) {
        return textResult(`No explicit permissions on "${resolved.item.name}" — it inherits.`);
      }
      return textResult(
        withPresentationHint(
          `Access to "${resolved.item.name}"\n\n${entries.map(permissionLine).join('\n')}`,
          'Render as a list of who has access.'
        )
      );
    }
  );

  server.registerTool(
    `${prefix}_share_document`,
    {
      title: `${title} · Act — Create a sharing link`,
      description:
        `Create a link that grants access to a document. Scope "anonymous" makes a link ` +
        `anyone can use — many organizations disable it, and Graph will refuse if so.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        linkType: z.enum(['view', 'edit']).describe('What the link allows.'),
        scope: z
          .enum(['anonymous', 'organization', 'users'])
          .describe('Who may use the link (default organization).')
          .optional(),
        expiresOn: z.string().describe('ISO-8601 expiry, e.g. 2026-12-31T00:00:00Z.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const created = await graphPost(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}/createLink`,
        {
          type: String(args.linkType),
          scope: str(args.scope) || 'organization',
          ...(str(args.expiresOn) ? { expirationDateTime: str(args.expiresOn) } : {}),
        }
      );
      if (!created.ok) return errText(created.error);
      const link = rec(created.body.link);
      return textResult(
        `Sharing link for "${resolved.item.name}" (${str(link.scope)}, ${str(link.type)}):\n${str(link.webUrl)}`
      );
    }
  );

  server.registerTool(
    `${prefix}_add_user_to_document`,
    {
      title: `${title} · Act — Give people access to a document`,
      description: `Grant named people read or write access to a file or folder.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        emails: z.array(z.string()).min(1).describe('Who to grant access to.'),
        role: z.enum(['read', 'write']).describe('What they may do.'),
        message: z.string().describe('Note to include in the invitation.').optional(),
        notify: z.boolean().describe('Email them about it (default true).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const emails = Array.isArray(args.emails) ? args.emails.map(String) : [];
      const invited = await graphPost(
        context,
        access.accessToken,
        `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}/invite`,
        {
          recipients: emails.map((email) => ({ email })),
          roles: [String(args.role)],
          requireSignIn: true,
          sendInvitation: args.notify !== false,
          ...(str(args.message) ? { message: str(args.message) } : {}),
        }
      );
      if (!invited.ok) return errText(invited.error);
      return textResult(
        `Granted ${String(args.role)} access to "${resolved.item.name}" for ${emails.join(', ')}.`
      );
    }
  );

  server.registerTool(
    `${prefix}_remove_user_from_document`,
    {
      title: `${title} · Act — Revoke access to a document`,
      description:
        `Remove a person's access, or delete a sharing link. Give either an email or a ` +
        `permission id from ${prefix}_list_document_access.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...selector,
        email: z.string().describe('Whose access to revoke.').optional(),
        permissionId: z.string().describe('Permission id to delete.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const fallback = await defaultDriveFor(options, context, access.accessToken);

      const resolved = await resolveDriveItem(
        context,
        access.accessToken,
        selectorOf(args),
        fallback
      );
      if (!resolved.ok) return errText(resolved.error);

      const base = `/drives/${resolved.item.driveId}/items/${resolved.item.itemId}`;
      let permissionId = str(args.permissionId);

      if (!permissionId) {
        const email = str(args.email).toLowerCase();
        if (!email) return errText('Give either an email or a permissionId.');
        const permissions = await graphGet(context, access.accessToken, `${base}/permissions`);
        if (!permissions.ok) return errText(permissions.error);
        for (const entry of values(permissions.body)) {
          const granted = rec(rec(entry.grantedToV2).user);
          const invitation = rec(entry.invitation);
          if (
            str(granted.email).toLowerCase() === email ||
            str(invitation.email).toLowerCase() === email
          ) {
            permissionId = str(entry.id);
            break;
          }
        }
        if (!permissionId) {
          return textResult(`${args.email} has no direct permission on "${resolved.item.name}".`);
        }
      }

      const removed = await graphDelete(
        context,
        access.accessToken,
        `${base}/permissions/${encodeURIComponent(permissionId)}`
      );
      if (!removed.ok) return errText(removed.error);
      return textResult(`Revoked access to "${resolved.item.name}".`);
    }
  );
}
