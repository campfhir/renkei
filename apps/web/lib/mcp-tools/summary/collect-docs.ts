/**
 * Documents that moved in the period — SharePoint libraries and Confluence
 * pages.
 *
 * Both answer "what did people change while I was not looking", so both list
 * WHAT changed and WHO changed it rather than reproducing content. A daily
 * summary that inlines document bodies stops being a summary; the reader who
 * wants the substance has sharepoint_read_document and confluence_get_page,
 * and the line here tells them which one to open.
 *
 * SharePoint is scoped to the libraries the user has watched. That is not a
 * shortcut — there is no "recent across everything" in delegated Graph that
 * would not mean crawling every site the user can reach on every summary.
 */

import { resolveGraphAccess, graphGet, values, str, rec } from '../graph/client';
import { resolveConfluenceAccess } from '../confluence/client';
import { listWatches } from '../content-watches';
import type { MCPToolContext } from '../common';
import { MAX_ITEMS_PER_SECTION, type SummaryPeriod, type SummarySection } from './types';

export async function collectSharePointChanges(
  context: MCPToolContext,
  period: SummaryPeriod
): Promise<SummarySection | null> {
  if (!context.subject || !context.accountId) return null;
  const access = await resolveGraphAccess(context);
  if (typeof access === 'string') return null;

  const watches = await listWatches(
    { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
    'sharepoint'
  );
  if (!watches.ok || watches.watches.length === 0) return null;

  const lines: string[] = [];
  let scanned = 0;

  for (const watch of watches.watches.filter((entry) => entry.enabled)) {
    if (lines.length >= MAX_ITEMS_PER_SECTION) break;
    scanned += 1;
    // Sorted by last-modified so the window can be applied client-side: Graph
    // has no $filter on driveItem lastModifiedDateTime for a children listing.
    const result = await graphGet(
      context,
      access.accessToken,
      `/drives/${watch.scopeKey}/root/children?$top=50` +
        '&$orderby=lastModifiedDateTime desc' +
        '&$select=name,webUrl,lastModifiedDateTime,lastModifiedBy,folder'
    );
    if (!result.ok) continue;

    for (const item of values(result.body)) {
      if (item.folder !== undefined) continue;
      const modified = str(item.lastModifiedDateTime);
      if (!modified || modified < period.start || modified >= period.end) continue;
      const who = str(rec(rec(item.lastModifiedBy).user).displayName) || 'someone';
      lines.push(
        `${modified.slice(11, 16)} ${str(item.name)} — ${who} (${watch.scopeLabel ?? watch.scopeKey})`
      );
      if (lines.length >= MAX_ITEMS_PER_SECTION) break;
    }
  }

  if (lines.length === 0) return null;
  return {
    connector: 'sharepoint',
    label: 'SharePoint documents changed',
    headline: `${lines.length} in ${scanned} watched librar${scanned === 1 ? 'y' : 'ies'}`,
    lines,
    omitted: 'only watched libraries are scanned; open a document to read it',
  };
}

export async function collectConfluenceChanges(
  context: MCPToolContext,
  period: SummaryPeriod
): Promise<SummarySection | null> {
  const access = await resolveConfluenceAccess(context);
  if (typeof access === 'string') return null;

  // CQL dates are day-granular, so the window is widened to whole days here
  // and narrowed back against the exact timestamp below.
  const since = period.start.slice(0, 10);
  const cql = encodeURIComponent(
    `type in (page, blogpost) and lastModified >= "${since}" order by lastModified desc`
  );
  const response = await fetch(
    `https://api.atlassian.com/ex/confluence/${access.cloudId}/wiki/rest/api/search?cql=${cql}&limit=${MAX_ITEMS_PER_SECTION}&expand=content.version,content.space`,
    { headers: { Authorization: `Bearer ${access.accessToken}`, Accept: 'application/json' } }
  ).catch(() => null);
  if (!response || !response.ok) return null;

  const body: unknown = await response.json().catch(() => null);
  const raw = rec(body).results;
  const results: unknown[] = Array.isArray(raw) ? raw : [];

  const lines: string[] = [];
  for (const entry of results) {
    const item = rec(entry);
    const content = rec(item.content);
    const version = rec(content.version);
    const when = str(version.when) || str(item.lastModified);
    // The CQL filter was day-granular; this is the real bound.
    if (!when || when < period.start || when >= period.end) continue;
    const who = str(rec(version.by).displayName) || 'someone';
    const space = str(rec(content.space).name);
    lines.push(
      `${when.slice(11, 16)} ${str(content.title) || str(item.title)} — ${who}${space ? ` (${space})` : ''}`
    );
  }

  if (lines.length === 0) return null;
  return {
    connector: 'atlassian-confluence',
    label: 'Confluence pages changed',
    headline: `${lines.length} updated`,
    lines,
  };
}
