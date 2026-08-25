/**
 * Polling sync for a watched Jira project or Confluence space.
 *
 * Polling rather than webhooks is a forced choice, not a preference:
 * Atlassian gives a plain OAuth app no way to register a Confluence webhook
 * at all (it is a Connect-app module, with no REST route and no scope), and
 * Jira's dynamic webhooks cap at five per user with a restrictive JQL
 * filter and a 30-day expiry. One polling path for both products beats a
 * split design where only half the content is fresh.
 *
 * Shaped after runSubscriptionSync (microsoft-sync.ts): an idempotent core
 * taking the watch row, callable from the sweep or any future producer,
 * deliberately NOT an EventHandler.
 *
 * Error posture, also copied from there:
 * - provider/DB failures throw (the caller retries),
 * - a single item failing to ingest is logged and skipped, because a throw
 *   would redo a whole round for one bad page,
 * - the cursor is written LAST, so a crash mid-round replays into
 *   idempotent upserts rather than skipping past unprocessed items.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { atlassianFetch, fieldScreenFor, listOf, rec, str } from '@renkei/connector-atlassian';
import { resolveEmbeddingProvider } from '@renkei/knowledge';
import { enqueueKnowledgeEvent } from '../enqueue';
import { TitleList } from '../log-titles';
import { jiraDocument } from './jira-document';
import { confluenceDocument } from './confluence-document';
import type { AtlassianAccess } from './atlassian-access';

/**
 * Overlap applied to the high-water mark on every round.
 *
 * Jira's search index is explicitly eventually consistent — its own docs
 * warn that a just-written issue may not appear yet — so a watermark set to
 * "the newest thing I saw" silently drops anything committed during the
 * round. Re-reading a couple of minutes of already-seen items is free
 * (ingestion upserts), missing one is not.
 */
const OVERLAP_MS = 2 * 60 * 1000;

/** Pages per round, so one enormous backlog can't monopolize the sweep. */
const MAX_PAGES = 10;

export interface WatchRow {
  id: string;
  tenant_id: string;
  provider: string;
  account_id: string;
  scope_type: string;
  scope_key: string;
  /** Human label for logs and the connectors page; no provider call needed. */
  scope_label: string | null;
  cursor: string | null;
}

export interface WatchSyncResult {
  /** Items ingested this round — the running count the connectors page shows. */
  items: number;
  /**
   * What was ingested, by name — an issue key and summary, or a page title.
   * Bounded; see log-titles.ts for why a log line must not grow with the
   * space it is indexing.
   */
  titles: string[];
  /** The new high-water mark, or null when nothing moved. */
  cursor: string | null;
}

/** An ISO instant `OVERLAP_MS` before the stored cursor, or null for a first run. */
function windowStart(cursor: string | null): string | null {
  if (!cursor) return null;
  const parsed = new Date(cursor);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() - OVERLAP_MS).toISOString();
}

/** Jira wants `yyyy/MM/dd HH:mm` in JQL, not ISO-8601. */
function jqlTimestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

async function syncJira(
  tenantId: string,
  access: AtlassianAccess,
  row: WatchRow
): Promise<WatchSyncResult> {
  const since = windowStart(row.cursor);
  const clauses = [`project = "${row.scope_key.replace(/"/g, '')}"`];
  // receivedDateTime-style ordering rule: the $orderby field must lead the
  // filter or Exchange-like engines refuse it. Jira is laxer, but leading
  // with `updated` also lets it use the index it actually has.
  if (since) clauses.unshift(`updated >= "${jqlTimestamp(since)}"`);
  const jql = `${clauses.join(' AND ')} ORDER BY updated ASC`;

  let items = 0;
  const indexed = new TitleList();
  let newest = row.cursor;
  let nextPageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await atlassianFetch({
      product: 'jira',
      cloudId: access.cloudId,
      accessToken: access.accessToken,
      path: '/rest/api/3/search/jql',
      method: 'POST',
      json: {
        jql,
        // `*navigable` rather than a fixed list: reporter, assignee, labels
        // and priority are predictable, but "Request participants" is a
        // custom field whose id differs per site, and so is most of what a
        // team actually fills in. Comments are named explicitly because they
        // are not navigable.
        // `comment` and `timetracking` are named explicitly because neither
        // is navigable — asking for `*navigable` alone silently returns no
        // logged time, which is how "45m logged" went missing from an issue
        // that plainly had it.
        fields: ['*navigable', 'comment', 'timetracking'],
        // A COMMA-DELIMITED STRING, not an array. This endpoint is the
        // exception and the API spec says so outright: "unlike the majority
        // of instances where `expand` is specified, `expand` is defined as a
        // comma-delimited string of values." Sent as an array it does not
        // expand, so the response carries no `names` map and every custom
        // field falls back to its raw id.
        expand: 'names',
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        `jira search failed for ${row.scope_key} (tenant ${tenantId}): ${response.status} ${response.error}`
      );
    }

    const issues = listOf(response.body, 'issues');
    // Jira returns one names map for the whole page, not per issue.
    const names = rec(response.body.names);
    for (const issue of issues) {
      const key = str(issue.key);
      const updated = str(rec(issue.fields).updated);
      if (!key) continue;
      // Cached per project + issue type inside the connector, so a page of
      // 100 issues costs one lookup per combination rather than 100.
      const screen = await fieldScreenFor({
        cloudId: access.cloudId,
        accessToken: access.accessToken,
        issueKey: key,
        projectKey: str(rec(rec(issue.fields).project).key),
        issueTypeId: str(rec(rec(issue.fields).issuetype).id),
      });
      const content = jiraDocument(issue, names, screen?.customFieldIds);
      if (!content.trim()) continue;

      await enqueueKnowledgeEvent(
        tenantId,
        'ingest.object',
        {
          provider: 'jira',
          refId: key,
          content,
          metadata: jiraMetadata(key, issue, row.scope_key, row.scope_label, access.siteUrl),
          sourceAt: updated || null,
        },
        // Successive versions of one issue stay serial; issues parallelize.
        `jira/${key}`
      );
      indexed.add(`${key}: ${str(rec(issue.fields).summary)}`.trim());
      items += 1;
      if (updated && (!newest || updated > newest)) newest = updated;
    }

    nextPageToken = str(response.body.nextPageToken) || null;
    if (!nextPageToken || issues.length === 0) break;
  }

  return { items, titles: indexed.titles(), cursor: newest };
}

async function syncConfluence(
  tenantId: string,
  access: AtlassianAccess,
  row: WatchRow
): Promise<WatchSyncResult> {
  const since = windowStart(row.cursor);
  let items = 0;
  const indexed = new TitleList();
  let newest = row.cursor;
  // Confluence v2 has no delta endpoint; newest-modified-first plus a
  // watermark is the closest equivalent, so we walk until we reach content
  // older than the cursor and stop.
  let path: string | null =
    `/wiki/api/v2/pages?space-id=${encodeURIComponent(row.scope_key)}` +
    `&sort=-modified-date&body-format=atlas_doc_format&limit=50`;

  for (let page = 0; page < MAX_PAGES && path; page += 1) {
    const response = await atlassianFetch({
      product: 'confluence',
      cloudId: access.cloudId,
      accessToken: access.accessToken,
      path,
    });
    if (!response.ok) {
      throw new Error(
        `confluence page list failed for space ${row.scope_key} (tenant ${tenantId}): ` +
          `${response.status} ${response.error}`
      );
    }

    const pages = listOf(response.body, 'results');
    let reachedWatermark = false;
    for (const entry of pages) {
      const id = str(entry.id) || String(rec(entry).id ?? '');
      const modified = str(rec(entry.version).createdAt);
      if (!id) continue;
      // Sorted newest-first, so the first item older than the watermark
      // means every remaining item is too.
      if (since && modified && modified < since) {
        reachedWatermark = true;
        break;
      }

      const title = str(entry.title);
      const bodyValue = str(rec(rec(rec(entry.body).atlas_doc_format)).value);
      const content = confluenceDocument(title, bodyValue);
      if (!content.trim()) continue;

      await enqueueKnowledgeEvent(
        tenantId,
        'ingest.object',
        {
          provider: 'confluence',
          refId: id,
          content,
          metadata: confluenceMetadata(
            id,
            title,
            entry,
            row.scope_key,
            row.scope_label,
            access.siteUrl
          ),
          sourceAt: modified || null,
        },
        `confluence/${id}`
      );
      indexed.add(title);
      items += 1;
      if (modified && (!newest || modified > newest)) newest = modified;
    }

    if (reachedWatermark) break;
    const nextLink = str(rec(response.body._links).next);
    path = nextLink || null;
  }

  return { items, titles: indexed.titles(), cursor: newest };
}

/**
 * One idempotent polling round for a watch. Records progress and the new
 * cursor; returns what it did so the sweep can log it.
 */
/**
 * What a Jira issue IS, in the words a person uses — plus the ids those
 * words came from.
 *
 * A knowledge result that says only "349536260" or an accountId cannot be
 * read, cited, or opened. So every resolved field ships next to its raw
 * value: the name for reading, the id for matching, and a url for going to
 * the actual thing.
 */
function jiraMetadata(
  key: string,
  issue: Record<string, unknown>,
  projectKey: string,
  projectLabel: string | null,
  siteUrl: string
): Record<string, unknown> {
  const fields = rec(issue.fields);
  const person = (value: unknown): { name: string; id: string; email: string } => {
    const who = rec(value);
    return {
      name: str(who.displayName),
      id: str(who.accountId),
      email: str(who.emailAddress),
    };
  };
  const reporter = person(fields.reporter);
  const assignee = person(fields.assignee);
  const summary = str(fields.summary);
  return {
    kind: 'issue',
    title: `${key}: ${summary}`,
    ticket: key,
    summary: summary || undefined,
    project: projectLabel || projectKey,
    projectKey,
    status: str(rec(fields.status).name) || undefined,
    issueType: str(rec(fields.issuetype).name) || undefined,
    priority: str(rec(fields.priority).name) || undefined,
    reporter: reporter.name || reporter.email || undefined,
    reporterId: reporter.id || undefined,
    reporterEmail: reporter.email || undefined,
    assignee: assignee.name || assignee.email || undefined,
    assigneeId: assignee.id || undefined,
    // JSM request type, when the issue is a service-desk request. The field
    // id varies by site, so read the rendered name Jira returns rather than
    // guessing a customfield number.
    requestType:
      str(rec(rec(fields.requestType).requestType).name) ||
      str(rec(fields.requestType).name) ||
      undefined,
    url: siteUrl ? `${siteUrl.replace(/\/$/, '')}/browse/${key}` : undefined,
  };
}

/** The same idea for a Confluence page: name it, attribute it, link it. */
function confluenceMetadata(
  id: string,
  title: string,
  entry: Record<string, unknown>,
  spaceKey: string,
  spaceLabel: string | null,
  siteUrl: string
): Record<string, unknown> {
  const version = rec(entry.version);
  const author = rec(version.author ?? entry.authorId);
  const authorName = str(author.displayName);
  const authorId = str(author.accountId) || str(entry.authorId);
  const base = siteUrl.replace(/\/$/, '');
  const webui = str(rec(entry._links).webui);
  return {
    kind: 'page',
    title: title || undefined,
    page: title || undefined,
    space: spaceLabel || spaceKey,
    spaceId: spaceKey,
    author: authorName || undefined,
    authorId: authorId || undefined,
    version: typeof version.number === 'number' ? version.number : undefined,
    // Confluence hands back a site-relative link; absolutize it so the row
    // is clickable without the reader knowing which site it came from.
    url: webui && base ? `${base}/wiki${webui}` : base ? `${base}/wiki/spaces` : undefined,
  };
}

export async function runWatchSync(
  tenantId: string,
  access: AtlassianAccess,
  row: WatchRow
): Promise<WatchSyncResult> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  const embedder = await resolveEmbeddingProvider(tenantId);
  if (!embedder) {
    // No embedding provider means the knowledge layer is off for this org.
    // Nothing to do, and not an error worth retrying.
    return { items: 0, titles: [], cursor: row.cursor };
  }

  const result =
    row.provider === 'jira'
      ? await syncJira(tenantId, access, row)
      : await syncConfluence(tenantId, access, row);

  // Cursor and counters written LAST and together: a crash before this
  // point replays the round into idempotent upserts, which is the safe
  // direction. Advancing the cursor first would skip unprocessed items.
  await db
    .updateTable('content_watches')
    .set({
      cursor: result.cursor,
      last_synced_at: sql<Date>`NOW()`,
      last_run_items: result.items,
      total_items: sql<number>`total_items + ${result.items}`,
      sync_status: 'idle',
      last_error: null,
      updated_at: sql<Date>`NOW()`,
    })
    .where('id', '=', row.id)
    .execute();

  return result;
}
