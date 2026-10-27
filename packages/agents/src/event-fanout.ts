/**
 * Connector event → agent runs. Called inline from the interactive
 * worker's pipeline at the moment it sees the thing happen (a new mail in
 * a sync round, a WebEx message being captured) — fan-out is one indexed
 * select plus an insert per hit, cheap enough to live in the hot path.
 *
 * v1 scoping rule: an event fires only agents whose OWNER the event
 * belongs to (the mail arrived in their mailbox, the message where they
 * are the linked user). An agent must not run on someone else's mail; the
 * shared-mailbox story is explicitly deferred.
 *
 * Payload discipline: identifiers plus small content (a ≤1KB body
 * preview), never bodies or attachments — the step's tool refetches by id
 * with the owner's own grant, which also re-checks access at use time.
 */

import { getDataStore } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { agentDefinitionOf } from './definition';
import { createAgentRun } from './runs';
import { matchesTriggerEvent } from './trigger-catalog';

export interface AgentEventInput {
  /** Catalog source/type, e.g. 'microsoft' / 'mail.received'. */
  source: string;
  type: string;
  /** The subject the event belongs to — only their agents fire. */
  ownerSubject: string;
  /** Becomes trigger.* variables; keys must match the catalog's provides. */
  payload: Record<string, unknown>;
  /**
   * The delivery's queue-row id — the firing-lock fallback for event types
   * whose payload carries no stable identifier of its own.
   */
  eventId?: string;
}

/**
 * The name of the source event, for the firing lock. Payload-derived where
 * the payload has a stable id — that is what makes the SAME message
 * delivered twice (duplicate webhook registrations produce distinct queue
 * rows) still count as one firing. The queue-row id fallback still
 * deduplicates replays of one delivery.
 */
function dedupeKeyFor(event: AgentEventInput): string | null {
  const payload = event.payload;
  const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
  if (messageId) return `msg:${messageId}`;
  const meetingUuid = typeof payload.meetingUuid === 'string' ? payload.meetingUuid : '';
  if (meetingUuid) return `meeting:${meetingUuid}`;
  // A batch reaches each of its states once, and a trigger listens to one
  // event type, so the batch id alone names the firing.
  const batchId = typeof payload.batchId === 'string' ? payload.batchId : '';
  if (batchId) return `batch:${batchId}`;
  return event.eventId ? `event:${event.eventId}` : null;
}

/** What one event did: the runs it started, and the triggers it did not. */
export interface FanOutResult {
  /** Run ids created, one per trigger that fired. */
  started: string[];
  /**
   * Triggers that WOULD have fired but for their own filters.
   *
   * Reported because "no run" has two very different causes that look the
   * same from outside: nothing was listening, or something was listening
   * and the filter turned this event away. Only the second means a person
   * wrote a rule, and only the second is worth reading when an agent that
   * should have run did not.
   */
  filtered: number;
}

/** Fire every enabled trigger matching this event. */
export async function fanOutAgentEvents(
  producer: QueueProducer,
  event: AgentEventInput
): Promise<FanOutResult> {
  const store = getDataStore();
  const triggers = await store.agents.listEventTriggers({
    source: event.source,
    type: event.type,
    ownerSubject: event.ownerSubject,
  });

  const dedupeKey = dedupeKeyFor(event);
  const eventId = `${event.source}/${event.type}`;
  const started: string[] = [];
  let filtered = 0;
  for (const trigger of triggers) {
    const config: { match?: unknown } =
      typeof trigger.config === 'object' &&
      trigger.config !== null &&
      !Array.isArray(trigger.config)
        ? trigger.config
        : {};
    // The deterministic gate, before the firing lock and before any run row
    // exists: a filtered-out event costs this comparison and nothing else.
    // The rules live in trigger-filters.ts so the builder that renders a
    // filter and the worker that applies it cannot drift.
    if (!matchesTriggerEvent(eventId, config.match, event.payload)) {
      // Counted, not just skipped. A filter working correctly and a filter
      // that is quietly wrong look identical from outside — both are an
      // agent that did not run — so the one number that separates them has
      // to leave this loop.
      filtered += 1;
      continue;
    }
    // The firing lock: one run per (trigger, source event), across every
    // worker process. Whoever wins this INSERT creates the run; a lost
    // conflict means another process (or a replay of this delivery, or a
    // duplicate webhook registration's second delivery) already did.
    if (dedupeKey) {
      const claimed = await store.agentTriggerFirings.claim(trigger.triggerId, dedupeKey);
      if (!claimed) continue;
    }

    const result = await createAgentRun(producer, {
      agentId: trigger.agentId,
      ownerSubject: trigger.ownerSubject,
      definition: agentDefinitionOf({ instructions: trigger.instructions, tools: trigger.tools }),
      llmModelId: trigger.llmModelId,
      triggerId: trigger.triggerId,
      triggerKind: 'event',
      initialState: event.payload,
    });
    if (result.ok) {
      started.push(result.val.runId);
      if (dedupeKey) {
        await store.agentTriggerFirings.setRun(trigger.triggerId, dedupeKey, result.val.runId);
      }
      await store.agents.markTriggerFired(trigger.triggerId);
    } else {
      // Release the claim so a redelivery may retry what a cap or outage
      // refused — mirrors createAgentRun's own "better no trace than a
      // phantom" cleanup.
      if (dedupeKey) {
        await store.agentTriggerFirings.release(trigger.triggerId, dedupeKey);
      }
      // A refused run (cap, cycle) is the trigger's news to carry, never
      // the pipeline's to fail on.
      await store.agents.markTriggerFailed(
        trigger.triggerId,
        result.err.message ?? `The run could not be started (${result.err.type}).`
      );
    }
  }
  return { started, filtered };
}
