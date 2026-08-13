/**
 * Turning what a person actually has — a pasted link, a site and a path —
 * into the (driveId, itemId) pair every Graph drive call needs.
 *
 * This is the single biggest usability lever in the drive tool surface.
 * Without it, every tool takes two opaque ids that a model must carry across
 * several steps without transcribing them wrong, and the common real request
 * ("summarise this document" with a URL pasted in) cannot be served at all.
 *
 * So every document tool accepts the same union and resolves it here:
 *
 *   itemUrl                    a pasted SharePoint/OneDrive link
 *   driveId + itemId           the ids, when a previous call returned them
 *   driveId + path             a path inside a known library
 *   site + library + path      the human way to name a document
 *
 * OneDrive resolves its own drive once and then uses the same /drives/{id}
 * surface as SharePoint, so both namespaces share one code path.
 */

import { graphGet, str, rec, type GraphResult } from './client';
import type { MCPToolContext } from '../common';

export interface DriveItemRef {
  driveId: string;
  itemId: string;
  name: string;
  webUrl: string;
}

export interface ItemSelector {
  itemUrl?: string;
  driveId?: string;
  itemId?: string;
  path?: string;
  site?: string;
  library?: string;
}

/**
 * Graph's sharing-URL encoding: base64url of the URL, `u!`-prefixed. Lets a
 * pasted link be resolved without knowing which site or drive it belongs to.
 */
export function encodeShareId(url: string): string {
  const base64 = Buffer.from(url, 'utf8').toString('base64');
  return `u!${base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

/** Escape a path for the `/root:/{path}:` addressing form. */
function encodePath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function itemFrom(body: Record<string, unknown>, fallbackDriveId?: string): DriveItemRef | null {
  const itemId = str(body.id);
  if (!itemId) return null;
  const parent = rec(body.parentReference);
  const driveId = str(parent.driveId) || fallbackDriveId || '';
  if (!driveId) return null;
  return { driveId, itemId, name: str(body.name), webUrl: str(body.webUrl) };
}

/**
 * A site URL or id → a site id. Accepts the full browser URL people paste,
 * because that is what they have.
 */
export async function resolveSite(
  context: MCPToolContext,
  token: string,
  site: string
): Promise<{ ok: true; siteId: string; name: string } | { ok: false; error: string }> {
  const trimmed = site.trim();
  if (!trimmed) return { ok: false, error: 'No site given.' };

  let path: string;
  if (trimmed.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, error: `Could not parse "${site}" as a site URL.` };
    }
    // Graph addresses a site as {hostname}:{server-relative path}. Anything
    // past the site root (a page, a library view) is not part of its address.
    const segments = parsed.pathname.split('/').filter(Boolean);
    const siteIndex = segments.indexOf('sites');
    const sitePath =
      siteIndex === -1 ? '' : `/${segments.slice(siteIndex, siteIndex + 2).join('/')}`;
    path = sitePath ? `/sites/${parsed.hostname}:${sitePath}` : `/sites/${parsed.hostname}`;
  } else {
    path = `/sites/${encodeURIComponent(trimmed)}`;
  }

  const result = await graphGet(context, token, `${path}?$select=id,displayName,webUrl`);
  if (!result.ok) return { ok: false, error: result.error };
  const siteId = str(result.body.id);
  if (!siteId) return { ok: false, error: `No SharePoint site matched "${site}".` };
  return { ok: true, siteId, name: str(result.body.displayName) };
}

/** A site's document library by name, or its default library when unnamed. */
export async function resolveLibrary(
  context: MCPToolContext,
  token: string,
  site: string,
  library?: string
): Promise<{ ok: true; driveId: string; name: string } | { ok: false; error: string }> {
  const resolved = await resolveSite(context, token, site);
  if (!resolved.ok) return resolved;

  if (!library) {
    const drive = await graphGet(context, token, `/sites/${resolved.siteId}/drive?$select=id,name`);
    if (!drive.ok) return { ok: false, error: drive.error };
    const driveId = str(drive.body.id);
    if (!driveId) return { ok: false, error: 'That site has no default document library.' };
    return { ok: true, driveId, name: str(drive.body.name) };
  }

  const drives = await graphGet(
    context,
    token,
    `/sites/${resolved.siteId}/drives?$select=id,name,webUrl`
  );
  if (!drives.ok) return { ok: false, error: drives.error };
  const list = Array.isArray(drives.body.value) ? drives.body.value : [];
  const wanted = library.trim().toLowerCase();
  for (const entry of list) {
    const candidate = rec(entry);
    if (str(candidate.name).toLowerCase() === wanted) {
      return { ok: true, driveId: str(candidate.id), name: str(candidate.name) };
    }
  }
  const names = list.map((entry) => str(rec(entry).name)).filter(Boolean);
  return {
    ok: false,
    error: `No library named "${library}" on that site. Available: ${names.join(', ') || 'none'}.`,
  };
}

/** The caller's own OneDrive id, resolved once so both namespaces share a code path. */
export async function resolveMyDriveId(
  context: MCPToolContext,
  token: string
): Promise<{ ok: true; driveId: string } | { ok: false; error: string }> {
  const result = await graphGet(context, token, '/me/drive?$select=id');
  if (!result.ok) return { ok: false, error: result.error };
  const driveId = str(result.body.id);
  if (!driveId) return { ok: false, error: 'Could not find your OneDrive.' };
  return { ok: true, driveId };
}

/**
 * Resolve any accepted selector to a concrete item.
 *
 * `defaultDriveId` lets the OneDrive namespace omit driveId everywhere: its
 * tools resolve /me/drive once and pass it in.
 */
export async function resolveDriveItem(
  context: MCPToolContext,
  token: string,
  selector: ItemSelector,
  defaultDriveId?: string
): Promise<{ ok: true; item: DriveItemRef } | { ok: false; error: string }> {
  const select = '?$select=id,name,webUrl,parentReference,size,file,folder';

  if (selector.itemUrl) {
    const shareId = encodeShareId(selector.itemUrl.trim());
    const result: GraphResult = await graphGet(
      context,
      token,
      `/shares/${shareId}/driveItem${select}`
    );
    if (!result.ok) {
      // Resolving a link outside the caller's own drive needs Files.Read.All,
      // and a bare 403 here reads as "broken tool" rather than "missing scope".
      return {
        ok: false,
        error: `${result.error} Resolving a pasted link needs the Files.Read.All scope.`,
      };
    }
    const item = itemFrom(result.body);
    return item
      ? { ok: true, item }
      : { ok: false, error: 'That link did not resolve to a file or folder.' };
  }

  let driveId = selector.driveId ?? defaultDriveId ?? '';

  if (!driveId && selector.site) {
    const library = await resolveLibrary(context, token, selector.site, selector.library);
    if (!library.ok) return library;
    driveId = library.driveId;
  }
  if (!driveId) {
    return {
      ok: false,
      error: 'Give either itemUrl, or driveId, or site (with an optional library name).',
    };
  }

  const address = selector.itemId
    ? `/drives/${driveId}/items/${encodeURIComponent(selector.itemId)}`
    : selector.path
      ? `/drives/${driveId}/root:/${encodePath(selector.path)}`
      : `/drives/${driveId}/root`;

  const result = await graphGet(context, token, `${address}${select}`);
  if (!result.ok) return { ok: false, error: result.error };
  const item = itemFrom(result.body, driveId);
  return item ? { ok: true, item } : { ok: false, error: 'That did not resolve to an item.' };
}
