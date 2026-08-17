/**
 * Domain events — the publish half of the pipeline's pub/sub seam.
 *
 * Provider handlers (a WebEx delivery fetched with the watcher's token, a
 * mail surfacing from a Graph delta round) used to call their subscribers
 * directly: agent fan-out here, knowledge enqueue there, each wired by
 * hand. Now they end by publishing ONE normalized domain event back onto
 * the `events` queue under a `domain:{provider}` source lane, and the
 * dispatch handler (handlers/domain-dispatch.ts) delivers it to every
 * subscriber. The intake stays provider-shaped and subscriber-agnostic;
 * what consumes an event is dispatch configuration, not connector wiring.
 *
 * Publishing is durable where the old direct calls were best-effort: a
 * failed publish throws, failing the provider event into the normal retry
 * path. That is safe precisely because the publish is the handler's LAST
 * act — the retry re-fetches and re-publishes, it does not replay
 * subscriber side effects. Subscriber failures, in turn, retry only the
 * cheap dispatch row, never the provider work.
 *
 * `data` keys are the trigger catalog's contract: every key becomes a
 * `trigger.*` variable the builder promises (@renkei/agents
 * trigger-catalog), so an entry there and a publish here must change
 * together.
 */

import { getDatabase } from '@renkei/db';
import { eventsQueue } from './queue';

/** Max characters of message/body content carried in a domain event.
 * Identifiers plus a small preview, never full bodies — subscribers
 * refetch by id under the owner's own grant (which re-checks access). */
export const BODY_PREVIEW_CHARS = 1_024;

/**
 * Only mail younger than this counts as "received". A delta round replays
 * changed items — a read-status flip on last month's mail arrives just
 * like a new message — and a full mailbox rebuild replays everything; the
 * recency window (with the rebuild skip at the call site) is what keeps
 * "an email arrives" meaning ARRIVES.
 */
const MAIL_RECENCY_MS = 24 * 60 * 60_000;

export function isRecentMail(receivedDateTime: string): boolean {
  const received = Date.parse(receivedDateTime);
  return Number.isFinite(received) && Date.now() - received < MAIL_RECENCY_MS;
}

/** The Microsoft grant's owner — whose event a mailbox notification is. */
export async function subjectForMicrosoftAccount(
  tenantId: string,
  accountId: string
): Promise<string | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('subject')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'microsoft')
    .where('provider_account_id', '=', accountId)
    .executeTakeFirst();
  return row?.subject ?? null;
}

export interface DomainEventInput {
  tenantId: string;
  /** Catalog source, e.g. 'webex' — becomes the `domain:{provider}` lane. */
  provider: 'webex' | 'microsoft' | 'zoom';
  /** Catalog type, e.g. 'message.received'. */
  type: string;
  /**
   * The subject the event belongs to. Carried in the payload — not
   * pre-filtered — so dispatch owns the v1 scoping rule (only the owner's
   * agents fire) and a future audience widening changes one place.
   */
  ownerSubject: string;
  /** Becomes trigger.* variables; keys must match the catalog's provides. */
  data: Record<string, unknown>;
  /** The source object's own timestamp (ISO), when the provider gives one. */
  occurredAt?: string;
  /**
   * Sequence name for messages that must stay serial through dispatch —
   * pass the intake event's key tail so serialization survives the hop.
   */
  orderingKey: string;
}

/**
 * Publish one domain event. Throws on enqueue failure: by the time a
 * provider handler publishes, delivering to subscribers is its whole
 * remaining job, so the event should fail into the retry path rather than
 * complete having told no one.
 */
export async function publishDomainEvent(event: DomainEventInput): Promise<void> {
  const enqueued = await eventsQueue.producer.enqueue({
    tenantId: event.tenantId,
    source: `domain:${event.provider}`,
    type: event.type,
    payload: {
      ownerSubject: event.ownerSubject,
      provider: event.provider,
      data: event.data,
      ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
    },
    orderingKey: `domain/${event.orderingKey}`,
  });
  if (!enqueued.ok) {
    throw new Error(
      `domain event ${event.provider}/${event.type} not published: ${enqueued.err.message ?? 'unknown'}`
    );
  }
}
