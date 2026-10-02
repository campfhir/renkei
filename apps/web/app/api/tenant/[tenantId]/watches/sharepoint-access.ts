/**
 * The SharePoint half of the watch routes' provider access: the caller's
 * Microsoft grant as a Graph fetcher (the delegate attaches the token), the
 * account it stands for (what a watch records so the worker knows which
 * grant to poll with), and the two Graph reads the routes make — a site by
 * URL or id, and a listing. Kept beside the routes rather than in
 * lib/mcp-tools/graph because those helpers serve the MCP tools; a route
 * has a session subject, not a tool context.
 */

import { graphRequest } from '@renkei/connector-microsoft';
import { MICROSOFT } from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';

export interface SharePointAccess {
  auth: AuthedFetch;
  accountId: string;
}

/** The caller's Microsoft grant, or the sentence to show when there is none usable. */
export async function resolveSharePointAccess(
  tenantId: string,
  subject: string
): Promise<SharePointAccess | string> {
  const ref = { tenantId, provider: MICROSOFT, subject };
  const described = await delegateGrants().describe(ref);
  if (!described.ok) {
    switch (described.err.type) {
      case 'NO_GRANT':
        return 'Microsoft is not connected. Connect it on the Connectors page, then try again.';
      case 'DELEGATE_UNCONFIGURED':
      case 'DELEGATE_UNREACHABLE':
        return 'The credential service is unavailable; try again shortly.';
      default:
        return 'Your Microsoft connection could not be read. Reconnect on the Connectors page.';
    }
  }
  return { auth: grantFetch(ref), accountId: described.val.accountId };
}

export type GraphAnswer =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

function describeGraphStatus(status: number | undefined): string {
  if (status === 403) {
    return (
      'Graph refused (403) — the grant likely lacks the needed scope, or the Entra app is ' +
      'missing the delegated permission. Reconnect Microsoft after the admin fixes the app.'
    );
  }
  if (status === 404) return 'Not found (404) — it may have been moved, renamed or deleted.';
  if (status === 429) return 'Graph is rate limiting (429); try again shortly.';
  return status ? `Microsoft Graph answered ${status}` : 'Could not reach graph.microsoft.com';
}

/** One Graph GET on the caller's grant, as a record. */
export async function sharePointGet(access: SharePointAccess, path: string): Promise<GraphAnswer> {
  const result = await graphRequest(access.auth, path, { lane: 'interactive' });
  if (!result.ok) {
    const status = typeof result.err.cause === 'number' ? result.err.cause : undefined;
    return { ok: false, error: describeGraphStatus(status) };
  }
  return typeof result.val === 'object' && result.val !== null && !Array.isArray(result.val)
    ? { ok: true, body: { ...result.val } }
    : { ok: false, error: 'Malformed Graph API response' };
}

/** The `value` array of a Graph listing, defensively. */
export function graphValues(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.value)
    ? body.value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}

export function graphStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A site URL or id → a site id and name. Accepts the full browser URL people
 * paste, because that is what they have — the same addressing the MCP
 * tools' resolveSite uses: Graph names a site {hostname}:{server-relative
 * path}, and anything past the site root is not part of its address.
 */
export async function resolveSharePointSite(
  access: SharePointAccess,
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
    const segments = parsed.pathname.split('/').filter(Boolean);
    const siteIndex = segments.indexOf('sites');
    const sitePath =
      siteIndex === -1 ? '' : `/${segments.slice(siteIndex, siteIndex + 2).join('/')}`;
    path = sitePath ? `/sites/${parsed.hostname}:${sitePath}` : `/sites/${parsed.hostname}`;
  } else {
    path = `/sites/${encodeURIComponent(trimmed)}`;
  }

  const result = await sharePointGet(access, `${path}?$select=id,displayName,webUrl`);
  if (!result.ok) return { ok: false, error: result.error };
  const siteId = graphStr(result.body.id);
  if (!siteId) return { ok: false, error: `No SharePoint site matched "${site}".` };
  return { ok: true, siteId, name: graphStr(result.body.displayName) };
}
