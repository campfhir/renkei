/**
 * Periodic polling of every watched content scope — Jira projects,
 * Confluence spaces, and SharePoint/OneDrive document libraries.
 *
 * Unlike the Microsoft subscription sweep, this is not repair — it is the
 * ONLY way this content stays fresh. Atlassian offers a plain OAuth app no
 * push mechanism for either product (see atlassian-watch.ts), and drives are
 * polled by choice: Graph drive subscriptions exist, but they would bind a
 * shared library's freshness to one user's notification URL, which stops
 * working the day that person leaves. RENKEI.md files SharePoint under
 * poll/delta sync for the same reason, and documents change on human
 * timescales.
 *
 * The outer cadence is a fixed constant like its sibling sweeps, but the
 * real due-time lives per WATCH ROW: the sweep gate is evaluated before any
 * tenant is known, so it cannot express a per-org or per-watch interval.
 * Each row's `last_synced_at` decides whether it runs this pass.
 *
 * Per-watch failures are logged onto the row and skipped; one revoked grant
 * or one bad project key must not stall polling for every other watch.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { actorForAccount } from '../log-actor';
import { summariseTitles } from '../log-titles';
import { getOrgSettings } from '@renkei/settings';
import { ATLASSIAN, ATLASSIAN_CONFLUENCE } from '@renkei/provider-grants';
import { logger } from '../logger';
import { resolveAtlassianAccess } from '../handlers/atlassian-access';
import { runWatchSync, type WatchRow } from '../handlers/atlassian-watch';
import { resolveMicrosoftAccess } from '../handlers/microsoft-access';
import { runDriveWatchSync } from '../handlers/sharepoint-watch';

const COMPONENT = 'content/watch-sweep';

/** How often the sweep itself wakes; per-row due-time does the real pacing. */
export const CONTENT_WATCH_INTERVAL_MS = 5 * 60_000;

/**
 * The floor of the per-org poll dial (`contentPollMinutes`): candidates are
 * fetched due-by-the-floor, then filtered per tenant against its own
 * setting — the sweep gate runs before any tenant is known, so the org dial
 * can only be applied after the rows are in hand.
 */
const MIN_WATCH_DUE_MS = 5 * 60_000;

/** Watches polled per pass, so a large org can't monopolize one sweep. */
const MAX_WATCHES_PER_PASS = 25;

/** The grant provider a watch's content lives behind. */
function grantProviderFor(watchProvider: string): string {
  return watchProvider === 'confluence' ? ATLASSIAN_CONFLUENCE : ATLASSIAN;
}

export async function sweepContentWatches(): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('database unavailable', { component: COMPONENT });
    return;
  }
  const db = dbResult.val;

  const now = Date.now();
  const dueBefore = new Date(now - MIN_WATCH_DUE_MS);
  let candidates: (WatchRow & { last_synced_at: Date | null })[];
  try {
    candidates = await db
      .selectFrom('content_watches')
      .select([
        'id',
        'tenant_id',
        'provider',
        'account_id',
        'scope_type',
        'scope_key',
        'scope_label',
        'cursor',
        'last_synced_at',
      ])
      .where('enabled', '=', true)
      // Never-synced rows (NULL) come first — a watch just created should
      // start indexing without waiting out a full interval.
      .where((eb) =>
        eb.or([eb('last_synced_at', 'is', null), eb('last_synced_at', '<', dueBefore)])
      )
      .orderBy('last_synced_at', (ob) => ob.asc().nullsFirst())
      .limit(MAX_WATCHES_PER_PASS)
      .execute();
  } catch (error) {
    logger.error('could not list due watches: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // The org dial: each tenant's contentPollMinutes decides how stale its
  // watches may get. Settings are cached (60s) per tenant, so this costs one
  // read per tenant per pass, not per watch. An unreadable settings row
  // falls back to the floor — polling too often beats silently never.
  const dueMsByTenant = new Map<string, number>();
  const dueMsFor = async (tenantId: string): Promise<number> => {
    const cached = dueMsByTenant.get(tenantId);
    if (cached !== undefined) return cached;
    const settings = await getOrgSettings(tenantId);
    const minutes = settings.ok ? Math.max(5, settings.val.contentPollMinutes) : 5;
    const ms = minutes * 60_000;
    dueMsByTenant.set(tenantId, ms);
    return ms;
  };
  const watches: WatchRow[] = [];
  for (const candidate of candidates) {
    const dueMs = await dueMsFor(candidate.tenant_id);
    if (
      candidate.last_synced_at === null ||
      new Date(candidate.last_synced_at).getTime() < now - dueMs
    ) {
      watches.push(candidate);
    }
  }

  if (watches.length === 0) return;
  logger.debug('polling {count} content watch(es)', {
    component: COMPONENT,
    count: watches.length,
  });

  for (const watch of watches) {
    try {
      if (watch.provider === 'sharepoint') {
        const access = await resolveMicrosoftAccess(watch.tenant_id, watch.account_id);
        await runDriveWatchSync(watch.tenant_id, access, watch);
        continue;
      }
      const access = await resolveAtlassianAccess(
        watch.tenant_id,
        watch.account_id,
        grantProviderFor(watch.provider)
      );
      const result = await runWatchSync(watch.tenant_id, access, watch);
      // The NAME, not the id: "349536260" tells a reader nothing, and the
      // watch row already carries the label the UI shows. The id stays in
      // the metadata, where searching for it still works.
      const scope = watch.scope_label ?? watch.scope_key;
      // The grant behind this watch names the person whose credential it
      // polls with — the one the indexed content is attributable to.
      const actor = await actorForAccount(db, watch.tenant_id, watch.account_id);
      const fields = {
        component: COMPONENT,
        tenantId: watch.tenant_id,
        provider: watch.provider,
        scope,
        scopeKey: watch.scope_key,
        userName: actor.displayName,
        subject: actor.subject,
        items: result.items,
        // What was taken in, by name. A count and a space label cannot
        // answer "did my page make it in?"; the titles can, and the handler
        // already had them.
        titles: result.titles,
        documents: summariseTitles(result.titles, result.items),
      };
      if (result.items > 0) {
        logger.info(
          'indexed {items} item(s) from {provider} {scope} for {userName}: {documents}',
          fields
        );
      } else {
        // A poll that found nothing is the normal case and says nothing;
        // at info it drowns the log in rows nobody can act on.
        logger.debug('no new items from {provider} {scope} for {userName}', fields);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('watch sync failed for {provider} {scope}: {error}', {
        component: COMPONENT,
        tenantId: watch.tenant_id,
        provider: watch.provider,
        scope: watch.scope_key,
        error: message,
      });
      // Record the failure ON THE ROW so it surfaces in the connectors UI
      // rather than living only in worker logs an end user never sees.
      // last_synced_at advances even on failure, so one persistently broken
      // watch is retried on the normal cadence instead of every pass.
      try {
        await db
          .updateTable('content_watches')
          .set({
            sync_status: 'error',
            last_error: message.slice(0, 500),
            last_synced_at: sql<Date>`NOW()`,
            updated_at: sql<Date>`NOW()`,
          })
          .where('id', '=', watch.id)
          .execute();
      } catch {
        // The row update failing is not worth failing the sweep over.
      }
    }
  }
}
