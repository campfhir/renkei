/**
 * The dispatch handler — the subscribe half of the pipeline's pub/sub seam
 * (publish half: ../domain-events.ts).
 *
 * Consumes `domain:{provider}` rows off the `events` queue and delivers
 * each to its subscribers, in a fixed order:
 *
 *   1. KNOWLEDGE — a static map decides which domain events are indexed.
 *      Enqueued STRICT and FIRST: nothing irreversible has happened yet,
 *      so a failed enqueue may throw and retry the whole dispatch row
 *      without double-firing anything.
 *   2. AGENTS — fanOutAgentEvents matches the owner's enabled event
 *      triggers and starts runs. Runs after knowledge because a retry
 *      here CAN double-fire in one narrow window (a trigger-bookkeeping
 *      write failing after its run was created); keeping it last means
 *      that window never replays the knowledge enqueue.
 *
 * Per-trigger refusals (caps, cycles) are recorded on
 * agent_triggers.last_error by the fan-out and are never dispatch
 * failures. Only infrastructure errors (database, queue) throw — that is
 * the upgrade over the old direct wiring, where any fan-out failure was
 * logged and swallowed and the event was simply lost.
 *
 * WebEx → knowledge is DELIBERATE and user-visible: the connectors page
 * copy discloses that watched-space messages are indexed (readable only
 * via live room-membership checks — createWebexUserAccessVerifier). If
 * indexing is ever made optional, gate the map entry AND change that copy
 * together.
 */

import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { fanOutAgentEvents } from '@renkei/agents/event-fanout';
import { webexRefId } from '@renkei/connector-webex';
import { enqueueKnowledgeEvent } from '../enqueue';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { logger } from '../logger';

const queue = agentJobsQueue();

interface DomainPayload {
  ownerSubject: string;
  provider: string;
  data: Record<string, unknown>;
  occurredAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(event: ClaimedEvent): DomainPayload | null {
  const payload: unknown = event.payload;
  if (!isRecord(payload)) return null;
  if (typeof payload.ownerSubject !== 'string' || !payload.ownerSubject) return null;
  if (typeof payload.provider !== 'string' || !payload.provider) return null;
  if (!isRecord(payload.data)) return null;
  return {
    ownerSubject: payload.ownerSubject,
    provider: payload.provider,
    data: payload.data,
    occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : undefined,
  };
}

type KnowledgeSubscriber = (tenantId: string, payload: DomainPayload) => Promise<void>;

/**
 * Which domain events feed the knowledge index. Microsoft and Zoom are
 * deliberately ABSENT: their knowledge writes live inside their sync
 * handlers, where purge-before-ingest ordering is inseparable from the
 * delta/refetch round.
 */
const KNOWLEDGE_SUBSCRIBERS: Record<string, KnowledgeSubscriber> = {
  'webex/message.received': async (tenantId, payload) => {
    const { roomId, messageId, text, sender } = payload.data;
    if (typeof roomId !== 'string' || typeof messageId !== 'string' || typeof text !== 'string') {
      return;
    }
    if (!roomId || !messageId || !text) return;
    const refId = webexRefId(roomId, messageId);
    // Idempotent across watchers: two opted-in users in one space publish
    // two domain events, but the unique (tenant, provider, refId) upsert
    // makes the second ingest a no-op rewrite of the same chunk.
    await enqueueKnowledgeEvent(
      tenantId,
      'ingest.object',
      {
        provider: 'webex',
        refId,
        content: text,
        metadata: {
          kind: 'msg',
          roomId,
          ...(typeof sender === 'string' && sender ? { sender } : {}),
        },
        sourceAt: payload.occurredAt ?? null,
      },
      refId,
      { strict: true }
    );
  },
};

export function createDomainDispatchHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    if (!payload) throw new Error('domain event payload missing ownerSubject/provider/data');

    const knowledge = KNOWLEDGE_SUBSCRIBERS[`${payload.provider}/${event.type}`];
    if (knowledge) await knowledge(event.tenant_id, payload);

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable for domain dispatch');
    const started = await fanOutAgentEvents(dbResult.val, queue.producer, {
      tenantId: event.tenant_id,
      source: payload.provider,
      type: event.type,
      ownerSubject: payload.ownerSubject,
      payload: payload.data,
      // Firing-lock fallback for payloads without a stable id of their
      // own — a replay of this row (the retry window in the header) then
      // still counts as the same firing.
      eventId: event.id,
    });
    if (started.length > 0) {
      logger.debug('{count} agent run(s) started for {source}/{type}', {
        component: 'worker/domain-dispatch',
        tenantId: event.tenant_id,
        source: payload.provider,
        type: event.type,
        count: started.length,
      });
    }
  };
}
