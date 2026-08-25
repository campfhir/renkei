/**
 * The Microsoft ingestion engine: ensure subscriptions exist for a grant,
 * and run delta rounds that turn mailbox changes into knowledge events.
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
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
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
 * for the interactive tools too, and granting Calendars.Read to use the
 * calendar tools must not silently index the calendar. Nothing opted in
 * (the default) means nothing is indexed.
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
    access.indexing.calendar &&
    (access.scopes.includes('Calendars.Read') || access.scopes.includes('Calendars.ReadWrite'))
  ) {
    resources.push('me/events');
  }
  if (
    access.indexing.tasks &&
    (access.scopes.includes('Tasks.Read') || access.scopes.includes('Tasks.ReadWrite'))
  ) {
    // To Do subscriptions are per list; enumerate them live. Lists created
    // later are picked up by the sweep's next ensure pass.
    const lists = await graphRequest(access.accessToken, '/me/todo/lists');
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
  if (resource.includes('events')) return initialDeltaUrl('calendar');
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
      // Opted out (or scope lost): stop Graph from notifying, but KEEP the
      // row — its delta_link is the cursor that makes a later re-enable
      // incremental. Already-indexed content stays, gated per read as ever.
      if (row.subscription_id !== null) {
        const removed = await deleteGraphSubscription(access.accessToken, row.subscription_id);
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
      const created = await createGraphSubscription(access.accessToken, {
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
      const renewed = await renewGraphSubscription(access.accessToken, subscriptionId);
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

/** A Graph message record as the connector-agnostic shape the sanitizer expects. */
/**
 * The correspondents on a Graph item, resolved to names with the addresses
 * beside them.
 *
 * "Evan Jeing <evan.jeing@nems.org>" is what someone reads; the bare address
 * is what they search for. Recording both costs nothing here and cannot be
 * reconstructed later — the sanitized body does not carry it.
 */
function correspondents(item: Record<string, unknown>): Record<string, unknown> {
  const one = (value: unknown): string => {
    const address = rec(rec(value).emailAddress);
    const name = str(address.name);
    const email = str(address.address);
    if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} <${email}>`;
    return email || name;
  };
  const many = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(one).filter((entry) => entry.length > 0) : [];
  const addresses = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => str(rec(rec(entry).emailAddress).address))
          .filter((entry) => entry.length > 0)
      : [];

  const from = one(item.from ?? item.sender);
  const to = many(item.toRecipients);
  const cc = many(item.ccRecipients);
  const organizer = one(item.organizer);
  const toAddresses = addresses(item.toRecipients);
  const ccAddresses = addresses(item.ccRecipients);
  return {
    from: from || undefined,
    fromAddress: str(rec(rec(item.from ?? item.sender).emailAddress).address) || undefined,
    to: to.length > 0 ? to : undefined,
    toAddresses: toAddresses.length > 0 ? toAddresses : undefined,
    cc: cc.length > 0 ? cc : undefined,
    ccAddresses: ccAddresses.length > 0 ? ccAddresses : undefined,
    organizer: organizer || undefined,
    hasAttachments: item.hasAttachments === true ? true : undefined,
  };
}

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

/** Text content per object kind — what gets embedded. Messages are handled separately (see sanitizeEmailForTenant). */
/**
 * Is there anything here worth embedding, beyond scheduling scaffolding?
 *
 * A calendar entry with no subject, body or preview reduces to "Event:" and
 * a pair of timestamps. That embeds to near-nothing, matches queries by
 * accident, and — because events run months into the future — outranks real
 * content in any recency-ordered view. Mail is exempt: the sanitizer already
 * decides what mail is worth keeping.
 */
function hasSubstance(kind: MicrosoftRefKind, item: Record<string, unknown>): boolean {
  if (kind === 'evt') {
    return Boolean(
      str(item.subject).trim() || str(rec(item.body).content).trim() || str(item.bodyPreview).trim()
    );
  }
  if (kind === 'task') {
    return Boolean(str(item.title).trim() || str(rec(item.body).content).trim());
  }
  return true;
}

/**
 * A Graph body reduced to the text worth embedding.
 *
 * Graph returns calendar and task bodies as HTML, and this used to embed
 * that HTML verbatim — tags, tracking blobs, and every link wrapped in a
 * `safelinks.protection.outlook.com` envelope (often wrapping a second
 * gateway inside it). An invite is mostly join links, so the stored chunk
 * ended up being mostly URL-encoding.
 *
 * That is all this does now: HTML to text, links decoded, whitespace
 * tidied. Deciding that a Teams join block is boilerplate — true for most
 * organizations, not all, and phrased differently in each — is a tenant's
 * call, made in a cleaner script pointed at the calendar kind.
 */
function readableBody(item: Record<string, unknown>): string {
  const body = rec(item.body);
  const content = str(body.content);
  if (!content) return str(item.bodyPreview);
  const contentType = str(body.contentType).toLowerCase() === 'html' ? 'html' : 'text';
  return decodeBody(normalizeBody({ content, contentType }));
}

/** The people on an invite, as names where Graph gave one. */
function attendeeList(item: Record<string, unknown>): { display: string[]; addresses: string[] } {
  const entries = Array.isArray(item.attendees) ? item.attendees : [];
  const display: string[] = [];
  const addresses: string[] = [];
  for (const entry of entries) {
    const address = rec(rec(entry).emailAddress);
    const email = str(address.address);
    const name = str(address.name);
    if (!email && !name) continue;
    display.push(
      name && email && name.toLowerCase() !== email.toLowerCase()
        ? `${name} <${email}>`
        : email || name
    );
    if (email) addresses.push(email);
  }
  return { display, addresses };
}

/**
 * The tenant's own cleaner scripts, over an invite or a task.
 *
 * Mail has had this since scripts shipped; calendar and tasks reach the
 * same stage now, so an org can strip a conferencing block, a room-booking
 * footer or whatever its own tooling staples onto invites without waiting
 * for a release. Only scripts an admin has marked as applying to this kind
 * run — a mail-only script keeps its old reach.
 *
 * Scripts are the last word, after the built-in cleaning: they exist to
 * handle what the shared rules could not.
 */
async function scripted(
  tenantId: string,
  kind: MicrosoftRefKind,
  item: Record<string, unknown>,
  content: string
): Promise<string> {
  if (kind !== 'evt' && kind !== 'task') return content;
  const organizer = rec(rec(item.organizer).emailAddress);
  return applyCleanerScriptsToItem({
    tenantId,
    kind,
    content,
    fields: {
      subject: str(item.subject) || str(item.title),
      organizer: str(organizer.name) || str(organizer.address) || null,
      attendees: attendeeList(item).display,
      location: str(rec(item.location).displayName) || null,
      startsAt: str(rec(item.start).dateTime) || null,
      endsAt: str(rec(item.end).dateTime) || null,
      isOnline: item.isOnlineMeeting === true,
    },
  });
}

function contentOf(kind: MicrosoftRefKind, item: Record<string, unknown>): string {
  if (kind === 'evt') {
    const organizer = rec(rec(item.organizer).emailAddress);
    const attendees = attendeeList(item).display.join(', ');
    const body = readableBody(item);
    return [
      `Event: ${str(item.subject)}`,
      `When: ${str(rec(item.start).dateTime)} → ${str(rec(item.end).dateTime)}`,
      `Organizer: ${str(organizer.name)} <${str(organizer.address)}>`,
      attendees ? `Attendees: ${attendees}` : '',
      '',
      body,
    ]
      .filter(Boolean)
      .join('\n');
  }
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
 * One delta round for one subscription row: fetch what changed, enqueue it
 * for the embedding queue, persist the new cursor last (at-least-once — a
 * crashed round re-runs into idempotent enqueues-then-upserts).
 *
 * All index writes — purges, per-item ingests, @removed deletes — ride the
 * embedding queue as individual jobs (Decision #20). A cursorless full
 * rebuild that used to embed a whole mailbox inside this ONE event, easily
 * outliving the queue's 10-minute claim lease, becomes one purge event plus
 * one bounded, independently-retryable event per item. Lane FIFO under the
 * single embedding consumer keeps the purge ahead of its re-ingests.
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
  // The stored cursor is either a deltaLink (a closed round) or a nextLink
  // (a round the page cap cut short) — both resume the enumeration exactly
  // where it stopped. Only a NULL cursor opens a fresh series.
  const fullRebuild = row.delta_link === null;
  const startUrl = row.delta_link ?? deltaStartUrl(row.resource);
  const round = await runDeltaRound(access.accessToken, startUrl);
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

  // A cursorless round returns the resource's whole current state, so it is
  // the one moment the old chunks can be dropped safely: anything still
  // present upstream is about to be re-ingested from this very response.
  // Without it, re-index can only ADD — items deleted at the source, or now
  // excluded by changed cleaning rules, would survive forever, and the
  // content-free calendar shells this sweep learned to skip would never
  // leave the index.
  //
  // Enqueued AFTER the fetch succeeded, never before, and ahead of every
  // per-item enqueue below. All of this round's jobs share the mailbox-kind
  // ordering key, so the purge runs before its re-ingests and deletes land
  // after ingests of the same resource — while different mailboxes drain in
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
  let changed = 0;
  let removed = 0;

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

    if (kind === 'msg') {
      // Mail goes to the embedding queue as one ingest.email job per
      // message; the sanitizer runs THERE, not here — its near-duplicate
      // check is itself an embedding call, and this loop must stay free of
      // the embeddings endpoint entirely. The sanitizer-derived metadata
      // (senderKey, templateVersion) is merged in by that handler.
      await enqueueKnowledgeEvent(
        tenantId,
        'ingest.email',
        {
          provider: MICROSOFT,
          refId,
          ownerUpn: access.upn,
          accountId: access.accountId,
          raw: rawEmailOf(entry),
          metadata: {
            kind,
            upn: access.upn,
            webLink: str(entry.webLink) || undefined,
            url: str(entry.webLink) || undefined,
            when: str(entry.receivedDateTime) || undefined,
            subject: str(entry.subject) || undefined,
            ...correspondents(entry),
          },
          sourceAt: str(entry.receivedDateTime) || null,
        },
        orderingKey
      );
      changed += 1;

      // Domain event: only genuinely NEW mail. A full rebuild replays the
      // whole mailbox and a delta round replays updated items (a
      // read-status flip on old mail); the rebuild skip plus the recency
      // window keep "an email arrives" meaning arrives. Subscribers
      // (agent triggers) are resolved by the dispatch handler.
      const receivedAt = str(entry.receivedDateTime);
      if (!fullRebuild && isRecentMail(receivedAt)) {
        const ownerSubject = await subjectForMicrosoftAccount(tenantId, access.accountId);
        if (ownerSubject) {
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
      }
      continue;
    }

    // Delta can hand back a bare shell — an id, a start and an end, with no
    // subject, organizer or body. Embedding that produces a chunk whose only
    // content is a timestamp: it matches nothing meaningfully, yet sorts to
    // the top of any recency browse because calendars run into the future.
    // One refetch recovers the full item when delta simply omitted it;
    // anything still empty is dropped, and any earlier empty version of it
    // removed, rather than left crowding the index.
    let item = entry;
    if (kind === 'evt' && !str(entry.subject) && !str(rec(entry.body).content)) {
      const full = await graphRequest(access.accessToken, `/me/events/${objectId}`);
      if (full.ok && isRecord(full.val)) item = full.val;
    }

    const content = await scripted(tenantId, kind, item, contentOf(kind, item));
    if (!hasSubstance(kind, item)) {
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
          webLink: str(item.webLink) || undefined,
          url: str(item.webLink) || undefined,
          ...correspondents(item),
          ...(() => {
            const { display, addresses } = attendeeList(item);
            return {
              attendees: display.length > 0 ? display : undefined,
              attendeeAddresses: addresses.length > 0 ? addresses : undefined,
              attendeeCount: display.length > 0 ? display.length : undefined,
              location: str(rec(item.location).displayName) || undefined,
              isOnline: item.isOnlineMeeting === true ? true : undefined,
            };
          })(),
          when:
            str(item.receivedDateTime) ||
            str(rec(item.start).dateTime) ||
            str(item.lastModifiedDateTime) ||
            undefined,
          subject: str(item.subject) || str(item.title) || undefined,
        },
        // Same precedence as `when` above: received (mail) → start (event) →
        // last-modified (task), whichever this kind actually carries.
        sourceAt:
          str(item.receivedDateTime) ||
          str(rec(item.start).dateTime) ||
          str(item.lastModifiedDateTime) ||
          null,
      },
      orderingKey
    );
    changed += 1;
  }

  // Counters ride along with the cursor write, in the same statement, so
  // progress can never claim more than the cursor actually covers. Totals
  // are a running count, never a denominator: no Graph delta tells you up
  // front how many items it will yield.
  //
  // A capped round persists its nextLink, not NULL: NULL would reopen the
  // series next round, purge the index and re-fetch the same head pages
  // forever on any mailbox larger than one round. The nextLink instead
  // continues the enumeration where the cap stopped it; `sync_status` stays
  // 'syncing' until Graph closes the series with a real deltaLink.
  const cursor = round.val.deltaLink ?? round.val.nextLink;
  await db
    .updateTable('webhook_subscriptions')
    .set({
      delta_link: cursor,
      last_synced_at: sql<Date>`NOW()`,
      last_run_items: changed,
      total_items: sql<number>`total_items + ${changed}`,
      sync_status: round.val.deltaLink === null && cursor !== null ? 'syncing' : 'idle',
      updated_at: sql`NOW()`,
    })
    .where('id', '=', row.id)
    .execute();

  return { changed, removed };
}
