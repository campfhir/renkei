/**
 * Managing your own content watches from the UI.
 *
 * The MCP tools (jira_watch_project, confluence_watch_space) do the same
 * thing, and both write the same rows through the same helpers — a watch
 * created here is indistinguishable from one an assistant created, which is
 * the point. Asking an LLM to change a setting is a fine option, not the
 * only one.
 *
 * Every route is scoped to the caller's own subject. A watch belongs to the
 * user whose grant polls it, so there is nothing here an admin could
 * usefully do on someone else's behalf.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ATLASSIAN, ATLASSIAN_CONFLUENCE } from '@renkei/provider-grants';
import { atlassianFetch, listOf, rec, str } from '@renkei/connector-atlassian';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import {
  resolveAtlassianUserAccess,
  type AtlassianUserProvider,
} from '@/lib/atlassian-user-access';
import { upsertWatch, disableWatch, listWatches } from '@/lib/mcp-tools/content-watches';
import { resolveGraphAccess, graphGet, values, str as gstr } from '@/lib/mcp-tools/graph/client';
import { resolveSite } from '@/lib/mcp-tools/graph/resolve';

type WatchProvider = 'jira' | 'confluence' | 'sharepoint';
type AtlassianWatchProvider = 'jira' | 'confluence';

function isWatchProvider(value: unknown): value is WatchProvider {
  return value === 'jira' || value === 'confluence' || value === 'sharepoint';
}

function grantProviderFor(provider: AtlassianWatchProvider): AtlassianUserProvider {
  return provider === 'jira' ? ATLASSIAN : ATLASSIAN_CONFLUENCE;
}

const SCOPE_TYPE: Record<WatchProvider, 'project' | 'space' | 'drive'> = {
  jira: 'project',
  confluence: 'space',
  // A SharePoint document library and a personal OneDrive are the same thing
  // to Graph, and scope_key is the driveId for both.
  sharepoint: 'drive',
};

/** GET — the caller's watches for one provider. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const provider = request.nextUrl.searchParams.get('provider');
  if (!isWatchProvider(provider)) {
    return NextResponse.json(
      { error: 'provider must be jira, confluence or sharepoint' },
      { status: 400 }
    );
  }

  const result = await listWatches({ tenantId, subject: session.subject, accountId: '' }, provider);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ watches: result.watches });
}

/**
 * POST — start watching a scope.
 *
 * The scope is resolved against the provider first, as the tools do: it
 * proves the caller can actually see it, and supplies the display label so
 * the list never has to call out again to render.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const provider = rec(body).provider;
  const scopeKey = str(rec(body).scopeKey).trim();
  if (!isWatchProvider(provider) || !scopeKey) {
    return NextResponse.json({ error: 'provider and scopeKey are required' }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok)
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  if (provider === 'sharepoint') {
    return watchLibrary(
      { tenantId, subject: session.subject, origin: originResult.val },
      str(rec(body).site).trim(),
      scopeKey
    );
  }

  const access = await resolveAtlassianUserAccess(
    tenantId,
    session.subject,
    grantProviderFor(provider),
    originResult.val
  );
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 400 });

  const resolved = await resolveScope(provider, access, scopeKey);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const result = await upsertWatch(
    { tenantId, subject: session.subject, accountId: access.accountId },
    provider,
    SCOPE_TYPE[provider],
    resolved.key,
    resolved.label
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ created: result.created, scopeKey: resolved.key });
}

/** DELETE — stop watching. Disables rather than deletes, keeping the cursor. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const provider = request.nextUrl.searchParams.get('provider');
  const scopeKey = request.nextUrl.searchParams.get('scopeKey');
  if (!isWatchProvider(provider) || !scopeKey) {
    return NextResponse.json({ error: 'provider and scopeKey are required' }, { status: 400 });
  }

  const result = await disableWatch(
    { tenantId, subject: session.subject, accountId: '' },
    provider,
    SCOPE_TYPE[provider],
    scopeKey
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ found: result.found });
}

/**
 * Start watching a SharePoint document library.
 *
 * The library is named by (site, driveId) rather than by driveId alone, and
 * the pair is checked against each other: the drive has to be one the SITE
 * actually lists. That is what makes the call self-validating — it proves the
 * caller can see the site, proves the drive is really one of its libraries,
 * and yields both display names in the one round trip, so the label matches
 * the "Site / Library" form sharepoint_watch_library writes. A bare driveId
 * would be accepted on faith and stored with no label at all.
 */
async function watchLibrary(
  owner: { tenantId: string; subject: string; origin: string },
  site: string,
  driveId: string
): Promise<NextResponse> {
  if (!site) {
    return NextResponse.json(
      { error: 'A site is required to watch a SharePoint library.' },
      { status: 400 }
    );
  }

  const context = { tenantId: owner.tenantId, subject: owner.subject, origin: owner.origin };
  const access = await resolveGraphAccess(context);
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 400 });

  const resolvedSite = await resolveSite(context, access.accessToken, site);
  if (!resolvedSite.ok) {
    return NextResponse.json({ error: resolvedSite.error }, { status: 400 });
  }

  const drives = await graphGet(
    context,
    access.accessToken,
    `/sites/${resolvedSite.siteId}/drives?$select=id,name`
  );
  if (!drives.ok) return NextResponse.json({ error: drives.error }, { status: 400 });

  const library = values(drives.body).find((drive) => gstr(drive.id) === driveId);
  if (!library) {
    return NextResponse.json(
      { error: 'That library is not one this site lists, or you cannot see it.' },
      { status: 400 }
    );
  }

  const label = `${resolvedSite.name} / ${gstr(library.name)}`;
  const result = await upsertWatch(
    { tenantId: owner.tenantId, subject: owner.subject, accountId: access.accountId },
    'sharepoint',
    'drive',
    driveId,
    label
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ created: result.created, scopeKey: driveId, label });
}

/**
 * Confirm the caller can see this scope, and get its label.
 *
 * Jira validates through the search endpoint rather than the project
 * endpoint on purpose — that is the call the poller makes, and the two need
 * different granular scopes (read:issue vs read:project), so checking with
 * the wrong one rejects projects the sync would read fine.
 */
async function resolveScope(
  provider: AtlassianWatchProvider,
  access: { accessToken: string; cloudId: string },
  scopeKey: string
): Promise<{ ok: true; key: string; label: string } | { ok: false; error: string }> {
  if (provider === 'jira') {
    const search = await atlassianFetch({
      product: 'jira',
      cloudId: access.cloudId,
      accessToken: access.accessToken,
      path: '/rest/api/3/search/jql',
      method: 'POST',
      json: { jql: `project = "${scopeKey.replace(/"/g, '')}"`, maxResults: 1, fields: ['key'] },
    });
    if (!search.ok) {
      return {
        ok: false,
        error:
          search.status === 401 || search.status === 403
            ? `Jira refused that project (${search.status}). Your connection may not carry the needed read scope.`
            : `Jira could not resolve project "${scopeKey}".`,
      };
    }
    // Best-effort label: this is the read:project:jira call, and a missing
    // display name must not block the watch.
    const project = await atlassianFetch({
      product: 'jira',
      cloudId: access.cloudId,
      accessToken: access.accessToken,
      path: `/rest/api/3/project/${encodeURIComponent(scopeKey)}`,
    });
    return {
      ok: true,
      key: scopeKey,
      label: (project.ok ? str(project.body.name) : '') || scopeKey,
    };
  }

  // Confluence watches are keyed by space id (what the v2 page listing
  // filters on), but people know their spaces by key — accept either.
  const byKey = await atlassianFetch({
    product: 'confluence',
    cloudId: access.cloudId,
    accessToken: access.accessToken,
    path: `/wiki/api/v2/spaces?keys=${encodeURIComponent(scopeKey)}&limit=1`,
  });
  const match = byKey.ok ? listOf(byKey.body, 'results')[0] : undefined;
  if (match) return { ok: true, key: str(match.id), label: str(match.name) || scopeKey };

  if (/^\d+$/.test(scopeKey)) {
    const byId = await atlassianFetch({
      product: 'confluence',
      cloudId: access.cloudId,
      accessToken: access.accessToken,
      path: `/wiki/api/v2/spaces/${encodeURIComponent(scopeKey)}`,
    });
    if (byId.ok && str(byId.body.id)) {
      return { ok: true, key: str(byId.body.id), label: str(byId.body.name) || scopeKey };
    }
  }
  return { ok: false, error: `No Confluence space "${scopeKey}" is visible to you.` };
}
