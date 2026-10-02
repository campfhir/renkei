/**
 * The Microsoft Graph subscription engine: ensure subscriptions exist for a
 * grant, and run delta rounds over what they watch.
 *
 * Two kinds of subscription, with two different jobs:
 *
 * - The INBOX subscription is a trigger feed, not an index. Mail is
 *   personal and is never written into the org knowledge index; new mail
 *   surfacing in a delta round is published as the `mail.received` domain
 *   event so agents with an "An email arrives" trigger wake, and subscribers
 *   read the message live under the owner's own grant. Nothing about a
 *   message is persisted here beyond that event's id-plus-preview payload.
 * - The To Do (tasks) subscriptions are indexed: each task becomes an
 *   ingest.object job on the embedding queue, deletions a delete.object.
 *
 * Calendar is neither: `me/events` is never subscribed any more (its
 * chunks were dropped by migration 135), and a lingering row is torn down
 * by the ensure pass below.
 *
 * Notifications never carry content — delta is the truth (RENKEI.md calls
 * delta queries the reliable sync backbone). Each webhook_subscriptions row
 * is both subscription state and the delta cursor, so the notification
 * path, the bootstrap backfill, and the scheduled staleness sweep all run
 * the exact same round; the orchestration never cares which producer fired.
 *
 * No embedding happens here (Decision #20): a round's index writes are
 * enqueued to the embedding queue per item, so this handler's own runtime
 * is bounded by Graph's clock, never the embeddings endpoint's.
 * Subscription/delta failures DO throw — those are retryable.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import {
  createGraphSubscription,
  renewGraphSubscription,
  deleteGraphSubscription,
  runDeltaRound,
  initialDeltaUrl,
  microsoftRefId,
  graphRequest,
  type MicrosoftRefKind,
} from '@renkei/connector-microsoft';
import { MICROSOFT } from '@renkei/provider-grants';
import { resolveEmbeddingProvider } from '@renkei/knowledge';
import { applyCleanerScriptsToItem, decodeBody, normalizeBody } from '@renkei/email-sanitizer';
import type { RawEmail } from '@renkei/email-sanitizer';
import { enqueueKnowledgeEvent } from '../enqueue';
import {
  publishDomainEvent,
  subjectForMicrosoftAccount,
  isRecentMail,
  BODY_PREVIEW_CHARS,
} from '../domain-events';
import { logger } from '../logger';
import type { MicrosoftAccess } from './microsoft-access';

const COMPONENT = 'microsoft/sync';

export interface SubscriptionRow {
  id: string;
  resource: string;
  subscription_id: string | null;
  client_state: string;
  expires_at: Date | null;
  delta_link: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Which resources this grant should have subscribed: scope AND the user's
 * explicit opt-in per category. Scopes alone are not consent — they exist
 * for the interactive tools too, and granting Mail.Read to use the mail
 * tools must not silently wire that mailbox to anyone's agents. Nothing
 * opted in (the default) means no subscriptions at all.
 *
 * The inbox subscription exists ONLY for the `mail.received` trigger; it
 * indexes nothing (see the module header). Calendar has no subscription:
 * calendar content is personal and left out of the index entirely.
 */
async function desiredResources(access: MicrosoftAccess): Promise<string[]> {
  const resources: string[] = [];
  if (
    access.indexing.mail &&
    (access.scopes.includes('Mail.Read') || access.scopes.includes('Mail.ReadWrite'))
  ) {
    resources.push("me/mailFolders('inbox')/messages");
  }
  if (
    access.indexing.tasks &&
    (access.scopes.includes('Tasks.Read') || access.scopes.includes('Tasks.ReadWrite'))
  ) {
    // To Do subscriptions are per list; enumerate them live. Lists created
    // later are picked up by the sweep's next ensure pass.
    const lists = await graphRequest(access.auth, '/me/todo/lists');
    if (lists.ok && isRecord(lists.val) && Array.isArray(lists.val.value)) {
      for (const list of lists.val.value) {
        const listId = str(rec(list).id);
        if (listId) resources.push(`me/todo/lists/${listId}/tasks`);
      }
    }
  }
  return resources;
}

function changeTypeFor(resource: string): string {
  // Messages reject 'deleted' subscriptions on some folders; deletions
  // arrive through delta's @removed entries regardless.
  return resource.includes('/messages') ? 'created,updated' : 'created,updated,deleted';
}

/**
 * The ref kind a subscription row's resource maps to. 'evt' is still
 * recognised so a lingering `me/events` row (from before calendar left the
 * index) is identified as such and skipped, never mistaken for a mailbox.
 */
export function refKindOfResource(resource: string): MicrosoftRefKind {
  if (resource.includes('/tasks')) return 'task';
  if (resource.includes('events')) return 'evt';
  return 'msg';
}

function deltaStartUrl(resource: string): string {
  if (resource.includes('/tasks')) {
    const match = /me\/todo\/lists\/([^/]+)\/tasks/.exec(resource);
    return initialDeltaUrl('todo', { listId: match?.[1] ?? '' });
  }
  return initialDeltaUrl('mail-inbox');
}

/** Renew inside this window; 15-minute sweeps leave plenty of margin. */
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * Idempotent reconciliation of one grant's subscriptions toward the desired
 * set: missing rows are inserted, unacknowledged or lapsed subscriptions
 * are (re)created at Graph, near-expiry ones are renewed — and rows the
 * user OPTED OUT of get their Graph subscription torn down while the row
 * (and its delta_link) stays, so re-enabling later resumes incrementally
 * instead of re-reading a whole mailbox. Returns only the DESIRED rows;
 * callers must not delta-poll what is not returned. Safe to run from the
 * connect bootstrap and every sweep alike.
 */
export async function ensureMicrosoftSubscriptions(
  tenantId: string,
  access: MicrosoftAccess,
  publicBaseUrl: string
): Promise<SubscriptionRow[]> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  const notificationUrl =
    `${publicBaseUrl.replace(/\/+$/, '')}/api/webhooks/microsoft/` +
    `${encodeURIComponent(tenantId)}/${encodeURIComponent(access.accountId)}`;

  const resources = await desiredResources(access);
  for (const resource of resources) {
    await db
      .insertInto('webhook_subscriptions')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        provider: MICROSOFT,
        account_id: access.accountId,
        resource,
        client_state: randomUUID(),
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'provider', 'account_id', 'resource']).doNothing()
      )
      .execute();
  }

  const rows = await db
    .selectFrom('webhook_subscriptions')
    .select(['id', 'resource', 'subscription_id', 'client_state', 'expires_at', 'delta_link'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('account_id', '=', access.accountId)
    .execute();

  const wanted = new Set(resources);
  const desired: SubscriptionRow[] = [];
  for (const row of rows) {
    if (!wanted.has(row.resource)) {
      // Opted out (or scope lost, or a resource this build no longer wants —
      // `me/events` after calendar left the index): stop Graph from
      // notifying, but KEEP the row — its delta_link is the cursor that
      // makes a later re-enable incremental. Already-indexed To Do content
      // stays, gated per read as ever.
      if (row.subscription_id !== null) {
        const removed = await deleteGraphSubscription(access.auth, row.subscription_id);
        if (!removed.ok) {
          logger.warn('could not delete Graph subscription for {resource}', {
            component: COMPONENT,
            tenantId,
            resource: row.resource,
          });
        }
        await db
          .updateTable('webhook_subscriptions')
          .set({ subscription_id: null, expires_at: null, updated_at: sql`NOW()` })
          .where('id', '=', row.id)
          .execute();
      }
      continue;
    }
    desired.push(row);
    const needsCreate =
      row.subscription_id === null ||
      row.expires_at === null ||
      new Date(row.expires_at).getTime() < Date.now();
    if (needsCreate) {
      const created = await createGraphSubscription(access.auth, {
        resource: row.resource,
        changeType: changeTypeFor(row.resource),
        notificationUrl,
        lifecycleNotificationUrl: notificationUrl,
        clientState: row.client_state,
      });
      if (!created.ok) {
        // Loud but not fatal to the rest of the set: the sweep retries.
        logger.warn('could not create Graph subscription for {resource}', {
          component: COMPONENT,
          tenantId,
          resource: row.resource,
        });
        continue;
      }
      await db
        .updateTable('webhook_subscriptions')
        .set({
          subscription_id: created.val.id,
          expires_at: created.val.expiresAt,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', row.id)
        .execute();
      row.subscription_id = created.val.id;
      row.expires_at = created.val.expiresAt;
      continue;
    }

    // Narrow into locals: the needsCreate branch above proved both non-null,
    // but the mutations inside the loop keep TypeScript from carrying that.
    const subscriptionId = row.subscription_id;
    const expiresAt = row.expires_at;
    if (subscriptionId === null || expiresAt === null) continue;

    if (new Date(expiresAt).getTime() - Date.now() < RENEW_WITHIN_MS) {
      const renewed = await renewGraphSubscription(access.auth, subscriptionId);
      if (renewed.ok) {
        await db
          .updateTable('webhook_subscriptions')
          .set({ expires_at: renewed.val.expiresAt, updated_at: sql`NOW()` })
          .where('id', '=', row.id)
          .execute();
        row.expires_at = renewed.val.expiresAt;
      } else {
        // A renewal that fails is usually a subscription Graph already
        // dropped; clear it so the next pass recreates instead of renewing.
        logger.warn('renewal failed for {resource}; will recreate next pass', {
          component: COMPONENT,
          tenantId,
          resource: row.resource,
        });
        await db
          .updateTable('webhook_subscriptions')
          .set({ subscription_id: null, expires_at: null, updated_at: sql`NOW()` })
          .where('id', '=', row.id)
          .execute();
        row.subscription_id = null;
        row.expires_at = null;
      }
    }
  }

  return desired;
}

/**
 * A Graph message record as the connector-agnostic shape the sanitizer
 * expects. Not used by the sync round any more — mail is never indexed —
 * but the message-override handler (microsoft-events.ts) still re-fetches
 * one message for the mail-review surface pending its removal.
 */
export function rawEmailOf(item: Record<string, unknown>): RawEmail {
  const from = rec(rec(item.from).emailAddress);
  // `sender` is Graph's RFC 5322 Sender — the actual authenticated sender,
  // which differs from `from` on "send on behalf of" mail (SharePoint/OneDrive
  // sharing notifications are the common case: `from` shows the sharing
  // colleague, `sender` is a Microsoft system account). `replyTo` is another
  // common system-relay tell. Both are the classifier's sender_domain/
  // reply_to_domain match types' data source.
  const sender = rec(rec(item.sender).emailAddress);
  const replyToList = Array.isArray(item.replyTo) ? item.replyTo : [];
  const firstReplyTo = replyToList.length > 0 ? rec(rec(replyToList[0]).emailAddress) : {};
  const bodyRec = rec(item.body);
  const htmlOrText = str(bodyRec.content);
  const contentType: 'html' | 'text' =
    htmlOrText && str(bodyRec.contentType).toLowerCase() === 'html' ? 'html' : 'text';
  return {
    subject: str(item.subject),
    fromName: str(from.name),
    fromAddress: str(from.address),
    senderAddress: str(sender.address) || undefined,
    replyToAddress: str(firstReplyTo.address) || undefined,
    // Graph's Message-ID header — the classifier's last-resort signal for
    // notifications that impersonate a real person in every visible header,
    // sender/reply-to included (observed on SharePoint/OneDrive share mail).
    messageId: str(item.internetMessageId) || undefined,
    receivedAt: str(item.receivedDateTime),
    body: { content: htmlOrText || str(item.bodyPreview), contentType },
  };
}

/**
 * Is there anything here worth embedding? A To Do item with neither a title
 * nor a body reduces to "Task:" and a status, which embeds to near-nothing
 * and matches queries by accident.
 */
function hasSubstance(item: Record<string, unknown>): boolean {
  return Boolean(str(item.title).trim() || str(rec(item.body).content).trim());
}

/**
 * A Graph body reduced to the text worth embedding.
 *
 * Graph returns task bodies as HTML, and this used to embed that HTML
 * verbatim — tags, tracking blobs, and every link wrapped in a
 * `safelinks.protection.outlook.com` envelope. That is all this does: HTML
 * to text, links decoded, whitespace tidied. Anything beyond that is a
 * tenant's call, made in a cleaner script pointed at the task kind.
 */
function readableBody(item: Record<string, unknown>): string {
  const body = rec(item.body);
  const content = str(body.content);
  if (!content) return str(item.bodyPreview);
  const contentType = str(body.contentType).toLowerCase() === 'html' ? 'html' : 'text';
  return decodeBody(normalizeBody({ content, contentType }));
}

/**
 * The tenant's own cleaner scripts, over a task. Only scripts an admin has
 * marked as applying to the task kind run. Scripts are the last word, after
 * the built-in cleaning: they exist to handle what the shared rules could
 * not.
 */
async function scripted(
  tenantId: string,
  item: Record<string, unknown>,
  content: string
): Promise<string> {
  return applyCleanerScriptsToItem({
    tenantId,
    kind: 'task',
    content,
    fields: { subject: str(item.title) },
  });
}

function contentOf(item: Record<string, unknown>): string {
  const body = readableBody(item);
  return [
    `Task: ${str(item.title)}`,
    `Status: ${str(item.status)}`,
    str(rec(item.dueDateTime).dateTime) ? `Due: ${str(rec(item.dueDateTime).dateTime)}` : '',
    '',
    body,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * One delta round for one subscription row: fetch what changed, act on it,
 * persist the new cursor last (at-least-once — a crashed round re-runs into
 * idempotent enqueues/publishes).
 *
 * For a To Do row, "act" means index writes — purges, per-item ingests,
 * @removed deletes — each riding the embedding queue as its own job
 * (Decision #20), sharing one ordering key so the purge of a cursorless
 * rebuild runs before its re-ingests.
 *
 * For the inbox row, "act" means publishing `mail.received` for genuinely
 * new mail, and nothing else: no ingest, no purge, no delete. Mail never
 * reaches the index, so the round needs no embedding provider either — the
 * trigger works for an org with the knowledge layer off.
 */
export async function runSubscriptionSync(
  tenantId: string,
  access: MicrosoftAccess,
  row: SubscriptionRow
): Promise<{ changed: number; removed: number }> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  const kind = refKindOfResource(row.resource);
  if (kind === 'evt') {
    // Calendar left the index. desiredResources never returns me/events, so
    // this row is being torn down by the ensure pass; until then it must not
    // be polled — and it must never be mistaken for a mailbox feed.
    logger.info('skipping delta round for retired resource {resource}', {
      component: COMPONENT,
      tenantId,
      resource: row.resource,
    });
    return { changed: 0, removed: 0 };
  }

  // The stored cursor is either a deltaLink (a closed round) or a nextLink
  // (a round the page cap cut short) — both resume the enumeration exactly
  // where it stopped. Only a NULL cursor opens a fresh series.
  const fullRebuild = row.delta_link === null;
  const startUrl = row.delta_link ?? deltaStartUrl(row.resource);
  const round = await runDeltaRound(access.auth, startUrl);
  if (!round.ok) {
    // An aged-out delta token (410: resyncRequired / SyncStateNotFound) is
    // not a failure — it is Graph's instruction to restart the series. The
    // drive path has handled this from day one; without it here, every
    // notification for the resource fails its whole attempt budget and
    // dead-letters, forever, because the poisoned cursor never changes.
    if (round.err.cause === 410 && row.delta_link !== null) {
      await db
        .updateTable('webhook_subscriptions')
        .set({ delta_link: null, sync_status: 'syncing', updated_at: sql`NOW()` })
        .where('id', '=', row.id)
        .execute();
      logger.info('delta token expired for {resource}; restarting the series', {
        component: COMPONENT,
        tenantId,
        resource: row.resource,
      });
      return runSubscriptionSync(tenantId, access, { ...row, delta_link: null });
    }
    // The Graph status and URL ride along — "delta round failed" alone once
    // hid a permanent 410 behind five retries per notification.
    throw new Error(
      `delta round failed for ${row.resource} (tenant ${tenantId}): ${round.err.message ?? 'unknown'}`
    );
  }

  let changed = 0;
  let removed = 0;

  if (kind === 'msg') {
    for (const entry of round.val.items) {
      if (!isRecord(entry)) continue;
      const objectId = str(entry.id);
      if (!objectId) continue;
      if (entry['@removed'] !== undefined) {
        // Nothing of this message was ever stored, so there is nothing to
        // remove; counted so the feed's progress row still reflects the
        // round.
        removed += 1;
        continue;
      }
      changed += 1;

      // Domain event: only genuinely NEW mail. A full rebuild replays the
      // whole mailbox and a delta round replays updated items (a
      // read-status flip on old mail); the rebuild skip plus the recency
      // window keep "an email arrives" meaning arrives. Subscribers (agent
      // triggers) are resolved by the dispatch handler and read the message
      // live, under the owner's grant — the event carries an id and a short
      // preview, never a body.
      const receivedAt = str(entry.receivedDateTime);
      if (fullRebuild || !isRecentMail(receivedAt)) continue;
      const ownerSubject = await subjectForMicrosoftAccount(tenantId, access.accountId);
      if (!ownerSubject) continue;
      await publishDomainEvent({
        tenantId,
        provider: 'microsoft',
        type: 'mail.received',
        ownerSubject,
        data: {
          subject: str(entry.subject),
          body: str(entry.bodyPreview).slice(0, BODY_PREVIEW_CHARS),
          from: str(rec(rec(entry.from).emailAddress).address),
          messageId: objectId,
        },
        occurredAt: receivedAt,
        orderingKey: `microsoft/${tenantId}/${access.accountId}`,
      });
    }
    await persistCursor(db, row.id, round.val, changed);
    return { changed, removed };
  }

  // A cursorless round returns the resource's whole current state, so it is
  // the one moment the old chunks can be dropped safely: anything still
  // present upstream is about to be re-ingested from this very response.
  // Without it, re-index can only ADD — items deleted at the source, or now
  // excluded by changed cleaning rules, would survive forever.
  //
  // Enqueued AFTER the fetch succeeded, never before, and ahead of every
  // per-item enqueue below. All of this round's jobs share the list-kind
  // ordering key, so the purge runs before its re-ingests and deletes land
  // after ingests of the same resource — while different accounts drain in
  // parallel across however many embedding workers are running.
  const orderingKey = `microsoft/${access.upn.toLowerCase()}/${kind}`;
  if (fullRebuild) {
    await enqueueKnowledgeEvent(
      tenantId,
      'purge.prefix',
      { provider: MICROSOFT, refIdPrefix: `${access.upn.toLowerCase()}/${kind}/` },
      orderingKey
    );
  }

  const embedder = await resolveEmbeddingProvider(tenantId);

  for (const entry of round.val.items) {
    if (!isRecord(entry)) continue;
    const objectId = str(entry.id);
    if (!objectId) continue;
    const refId = microsoftRefId(access.upn, kind, objectId);

    if (isRecord(entry['@removed']) || entry['@removed'] !== undefined) {
      await enqueueKnowledgeEvent(
        tenantId,
        'delete.object',
        { provider: MICROSOFT, refId },
        orderingKey
      );
      removed += 1;
      continue;
    }

    if (!embedder) continue; // knowledge layer off for this org

    const content = await scripted(tenantId, entry, contentOf(entry));
    if (!hasSubstance(entry)) {
      await enqueueKnowledgeEvent(
        tenantId,
        'delete.object',
        { provider: MICROSOFT, refId },
        orderingKey
      );
      continue;
    }
    if (!content.trim()) continue;
    await enqueueKnowledgeEvent(
      tenantId,
      'ingest.object',
      {
        provider: MICROSOFT,
        refId,
        content,
        metadata: {
          kind,
          upn: access.upn,
          webLink: str(entry.webLink) || undefined,
          url: str(entry.webLink) || undefined,
          when: str(entry.lastModifiedDateTime) || undefined,
          subject: str(entry.title) || undefined,
        },
        sourceAt: str(entry.lastModifiedDateTime) || null,
      },
      orderingKey
    );
    changed += 1;
  }

  await persistCursor(db, row.id, round.val, changed);
  return { changed, removed };
}

/**
 * Counters ride along with the cursor write, in the same statement, so
 * progress can never claim more than the cursor actually covers. Totals
 * are a running count, never a denominator: no Graph delta tells you up
 * front how many items it will yield.
 *
 * A capped round persists its nextLink, not NULL: NULL would reopen the
 * series next round, purge the index and re-fetch the same head pages
 * forever on any mailbox larger than one round. The nextLink instead
 * continues the enumeration where the cap stopped it; `sync_status` stays
 * 'syncing' until Graph closes the series with a real deltaLink.
 */
async function persistCursor(
  db: Kysely<DB>,
  rowId: string,
  round: { deltaLink: string | null; nextLink?: string | null },
  changed: number
): Promise<void> {
  const cursor = round.deltaLink ?? round.nextLink ?? null;
  await db
    .updateTable('webhook_subscriptions')
    .set({
      delta_link: cursor,
      last_synced_at: sql<Date>`NOW()`,
      last_run_items: changed,
      total_items: sql<number>`total_items + ${changed}`,
      sync_status: round.deltaLink === null && cursor !== null ? 'syncing' : 'idle',
      updated_at: sql`NOW()`,
    })
    .where('id', '=', rowId)
    .execute();
}
