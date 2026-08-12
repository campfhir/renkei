/**
 * The Microsoft ingestion engine: ensure subscriptions exist for a grant,
 * and run delta rounds that turn mailbox changes into knowledge chunks.
 *
 * Notifications never carry content — delta is the truth (RENKEI.md calls
 * delta queries the reliable sync backbone). Each webhook_subscriptions row
 * is both subscription state and the delta cursor, so the notification
 * path, the bootstrap backfill, and the scheduled staleness sweep all run
 * the exact same round; the orchestration never cares which producer fired.
 *
 * Chunk failures are logged, not thrown (the webex-capture convention): a
 * throw would retry the whole event and re-do work the upsert already
 * absorbed. Subscription/delta failures DO throw — those are retryable.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import {
  createGraphSubscription,
  renewGraphSubscription,
  runDeltaRound,
  initialDeltaUrl,
  microsoftRefId,
  graphRequest,
  type MicrosoftRefKind,
} from '@renkei/connector-microsoft';
import { MICROSOFT } from '@renkei/provider-grants';
import {
  resolveEmbeddingProvider,
  ingestObjectChunks,
  deleteObjectChunks,
} from '@renkei/knowledge';
import { sanitizeEmailForTenant } from '@renkei/email-sanitizer';
import type { RawEmail } from '@renkei/email-sanitizer';
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

/** Which resources this grant's scopes entitle it to have subscribed. */
async function desiredResources(access: MicrosoftAccess): Promise<string[]> {
  const resources: string[] = [];
  if (access.scopes.includes('Mail.Read') || access.scopes.includes('Mail.ReadWrite')) {
    resources.push("me/mailFolders('inbox')/messages");
  }
  if (access.scopes.includes('Calendars.Read') || access.scopes.includes('Calendars.ReadWrite')) {
    resources.push('me/events');
  }
  if (access.scopes.includes('Tasks.Read') || access.scopes.includes('Tasks.ReadWrite')) {
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
 * are (re)created at Graph, near-expiry ones are renewed. Safe to run from
 * the connect bootstrap and every sweep alike.
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

  for (const row of rows) {
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

  return rows;
}

/** A Graph message record as the connector-agnostic shape the sanitizer expects. */
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
function contentOf(kind: MicrosoftRefKind, item: Record<string, unknown>): string {
  if (kind === 'evt') {
    const organizer = rec(rec(item.organizer).emailAddress);
    const attendees = Array.isArray(item.attendees)
      ? item.attendees
          .map((entry) => str(rec(rec(entry).emailAddress).address))
          .filter(Boolean)
          .join(', ')
      : '';
    const body = str(rec(item.body).content) || str(item.bodyPreview);
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
  const body = str(rec(item.body).content);
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
 * One delta round for one subscription row: fetch what changed, embed it,
 * delete what @removed, persist the new cursor last (at-least-once — a
 * crashed round re-runs into idempotent upserts).
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
  const startUrl = row.delta_link ?? deltaStartUrl(row.resource);
  const round = await runDeltaRound(access.accessToken, startUrl);
  if (!round.ok) {
    throw new Error(`delta round failed for ${row.resource} (tenant ${tenantId})`);
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
      const deleted = await deleteObjectChunks(tenantId, MICROSOFT, refId);
      if (deleted.ok) removed += 1;
      continue;
    }

    if (!embedder) continue; // knowledge layer off for this org

    if (kind === 'msg') {
      // Mail goes through the sanitizer, not straight to embedding: classify
      // (human/system-notification/marketing), clean or extract, and log the
      // decision under this mailbox's own owner_upn — see
      // packages/email-sanitizer. Never admin-visible; see that package's
      // persistence/log.ts for why.
      const sanitized = await sanitizeEmailForTenant({
        tenantId,
        provider: MICROSOFT,
        refId,
        ownerUpn: access.upn,
        accountId: access.accountId,
        raw: rawEmailOf(entry),
        // Enables near-duplicate detection alongside the exact-hash check;
        // costs one extra embed call per non-exact-duplicate message (the
        // content is re-embedded again below for actual storage — a known,
        // accepted inefficiency rather than reworking ingestObjectChunks to
        // accept a precomputed vector).
        embedder,
      });

      if (sanitized.action === 'excluded') {
        // Marketing, an exact duplicate, or the owner's own removal — if
        // something was indexed under an earlier classification, drop it.
        await deleteObjectChunks(tenantId, MICROSOFT, refId);
        continue;
      }

      const ingested = await ingestObjectChunks(tenantId, embedder, {
        provider: MICROSOFT,
        refId,
        content: sanitized.content,
        metadata: {
          kind,
          upn: access.upn,
          webLink: str(entry.webLink) || undefined,
          when: str(entry.receivedDateTime) || undefined,
          subject: str(entry.subject) || undefined,
          senderKey: sanitized.senderKey ?? undefined,
          templateVersion: sanitized.templateVersion ?? undefined,
        },
      });
      if (!ingested.ok) {
        logger.warn('could not index {kind} object', { component: COMPONENT, tenantId, kind });
        continue;
      }
      changed += 1;
      continue;
    }

    const content = contentOf(kind, entry);
    if (!content.trim()) continue;
    const ingested = await ingestObjectChunks(tenantId, embedder, {
      provider: MICROSOFT,
      refId,
      content,
      metadata: {
        kind,
        upn: access.upn,
        webLink: str(entry.webLink) || undefined,
        when:
          str(entry.receivedDateTime) ||
          str(rec(entry.start).dateTime) ||
          str(entry.lastModifiedDateTime) ||
          undefined,
        subject: str(entry.subject) || str(entry.title) || undefined,
      },
    });
    if (!ingested.ok) {
      logger.warn('could not index {kind} object', {
        component: COMPONENT,
        tenantId,
        kind,
      });
      continue;
    }
    changed += 1;
  }

  await db
    .updateTable('webhook_subscriptions')
    .set({ delta_link: round.val.deltaLink, updated_at: sql`NOW()` })
    .where('id', '=', row.id)
    .execute();

  return { changed, removed };
}
