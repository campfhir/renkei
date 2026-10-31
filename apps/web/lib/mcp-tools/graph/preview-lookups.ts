/**
 * What the Microsoft 365 preview lookups (onedrive/, sharepoint/, onenote/,
 * outlook/, teams/ each register their own) share: a read-only Graph reader
 * on the caller's grant, and the lookups for the document tools both file
 * namespaces carry. Each lookup only reads; a failure leaves the name out
 * and the card says "a folder", never the id.
 */

import type { MCPToolContext } from '../common';
import { registerPreviewLookups, type PreviewLookup } from '../lookup';
import { nameKey, record, text, type Args, type Names } from '../previews/card';
import { graphGet } from './client';
import type { GraphAuth } from './graph-auth';
import { folderPathOf } from './documents';
import { resolveDriveItem, resolveMyDriveId, resolveSite } from './resolve';

export interface GraphReader {
  /** The JSON at a Graph path, or null on any failure. */
  get(path: string): Promise<Args | null>;
  /** A site from its address or id: its id and display name; null when it can't be found. */
  site(site: unknown): Promise<{ id: string; name: string } | null>;
  /** The grant's own account address, when it recorded one. */
  upn(): Promise<string>;
  /** The caller's own drive id. */
  myDriveId(): Promise<string>;
  /** A drive item (name and drive) from a document tool's selector arguments. */
  item(
    args: Args,
    defaultDriveId?: string
  ): Promise<{ name: string; driveId: string; itemId: string } | null>;
}

export const enc = (value: unknown): string => encodeURIComponent(text(value));

/** One reader per lookup run: the grant is resolved once, on first use. */
export function graphReader(context: MCPToolContext, auth: GraphAuth): GraphReader {
  let resolved: ReturnType<GraphAuth['resolve']> | undefined;
  const access = async () => {
    resolved ??= auth.resolve();
    const value = await resolved;
    return typeof value === 'string' ? null : value;
  };
  const reader: GraphReader = {
    async get(path) {
      try {
        const granted = await access();
        if (!granted) return null;
        const result = await graphGet(context, granted.auth, path);
        return result.ok ? record(result.body) : null;
      } catch {
        return null;
      }
    },
    async site(site) {
      try {
        const granted = await access();
        if (!granted || !text(site)) return null;
        const found = await resolveSite(context, granted.auth, text(site));
        return found.ok ? { id: found.siteId, name: found.name } : null;
      } catch {
        return null;
      }
    },
    async upn() {
      try {
        return (await access())?.upn ?? '';
      } catch {
        return '';
      }
    },
    async myDriveId() {
      try {
        const granted = await access();
        if (!granted) return '';
        const mine = await resolveMyDriveId(context, granted.auth);
        return mine.ok ? mine.driveId : '';
      } catch {
        return '';
      }
    },
    async item(args, defaultDriveId) {
      try {
        const granted = await access();
        if (!granted) return null;
        const found = await resolveDriveItem(
          context,
          granted.auth,
          {
            itemUrl: text(args.itemUrl) || undefined,
            driveId: text(args.driveId) || undefined,
            itemId: text(args.itemId) || undefined,
            path: text(args.path) || undefined,
            site: text(args.site) || undefined,
            library: text(args.library) || undefined,
          },
          defaultDriveId
        );
        return found.ok
          ? { name: found.item.name, driveId: found.item.driveId, itemId: found.item.itemId }
          : null;
      } catch {
        return null;
      }
    },
  };
  return reader;
}

/** Run a lookup body with a fresh reader. */
export const withReader =
  (
    context: MCPToolContext,
    auth: GraphAuth,
    body: (read: GraphReader, args: Args) => Promise<Names>
  ): PreviewLookup =>
  (args) =>
    body(graphReader(context, auth), args);

const only = (kind: string, id: unknown, label: string): Names =>
  label ? { [nameKey(kind, text(id))]: label } : {};

/** A folder as a person would say it: where it sits, then its name. */
export function folderLabel(entry: Args): string {
  const name = text(entry.name);
  if (!name) return '';
  const parent = folderPathOf(entry);
  return parent && parent !== '/' ? `${parent}/${name}` : name;
}

/** Who a permission is for: a person, a group or a sharing link. */
export function permissionLabel(entry: Args): string {
  const granted = record(entry.grantedToV2);
  const link = record(entry.link);
  const user = record(granted.user);
  return (
    text(user.displayName) ||
    text(user.email) ||
    text(record(granted.siteGroup).displayName) ||
    text(record(entry.invitation).email) ||
    (text(link.scope) ? `${text(link.scope)} sharing link` : '')
  );
}

/**
 * The names behind a OneDrive / SharePoint document act: the item when it was
 * named by id, the destination folder, the person behind a permission and the
 * site. `prefix` is the tool namespace; OneDrive defaults to the caller's own
 * drive.
 */
export function registerDocumentPreviewLookups(
  context: MCPToolContext,
  auth: GraphAuth,
  prefix: 'onedrive' | 'sharepoint'
): void {
  const documents = withReader(context, auth, async (read, args) => {
    const names: Record<string, string> = {};
    const site = text(args.site);
    const siteFound = site ? read.site(site) : Promise.resolve(null);

    const wantsItem = Boolean(
      (text(args.itemId) && !text(args.path) && !text(args.itemUrl)) ||
      text(args.destinationFolderId) ||
      text(args.permissionId)
    );
    const item = wantsItem
      ? await read.item(args, prefix === 'onedrive' ? await read.myDriveId() : undefined)
      : null;
    if (item && text(args.itemId) && item.name) {
      Object.assign(names, only('item', args.itemId, item.name));
    }

    const folderId = text(args.destinationFolderId);
    const destinationDrive = text(args.destinationDriveId) || item?.driveId;
    if (folderId && destinationDrive) {
      const folder = await read.get(
        `/drives/${enc(destinationDrive)}/items/${enc(folderId)}?$select=name,parentReference`
      );
      if (folder) Object.assign(names, only('folder', folderId, folderLabel(folder)));
    }

    const permissionId = text(args.permissionId);
    if (permissionId && item) {
      const found = await read.get(
        `/drives/${enc(item.driveId)}/items/${enc(item.itemId)}/permissions/${enc(permissionId)}`
      );
      if (found) Object.assign(names, only('permission', permissionId, permissionLabel(found)));
    }

    Object.assign(names, only('site', site, (await siteFound)?.name ?? ''));
    return names;
  });

  const tools = [
    'create_folder',
    'copy_document',
    'move_document',
    'rename_document',
    'delete_document',
    'share_document',
    'add_user_to_document',
    'remove_user_from_document',
    ...(prefix === 'sharepoint'
      ? ['update_document_metadata', 'watch_library', 'unwatch_library']
      : []),
  ];
  registerPreviewLookups(
    context,
    Object.fromEntries(tools.map((tool) => [`${prefix}_${tool}`, documents]))
  );
}
