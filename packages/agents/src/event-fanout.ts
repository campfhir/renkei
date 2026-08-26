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

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { isAgentStepsDoc } from './steps';
import { createAgentRun } from './runs';
import { matchesTriggerEvent } from './trigger-catalog';

export interface AgentEventInput {
  tenantId: string;
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
  return event.eventId ? `event:${event.eventId}` : null;
}

/** Fire every enabled trigger matching this event. Returns run ids started. */
export async function fanOutAgentEvents(
  db: Kysely<DB>,
  producer: QueueProducer,
  event: AgentEventInput
): Promise<string[]> {
  const triggers = await db
    .selectFrom('agent_triggers as t')
    .innerJoin('agents as a', 'a.id', 't.agent_id')
    .select([
      't.id as trigger_id',
      't.agent_id',
      't.config',
      'a.owner_subject',
      'a.steps',
      'a.llm_model_id',
    ])
    .where('t.tenant_id', '=', event.tenantId)
    .where('t.kind', '=', 'event')
    .where('t.enabled', '=', true)
    .where('t.event_source', '=', event.source)
    .where('t.event_type', '=', event.type)
    .where('a.enabled', '=', true)
    .where('a.owner_subject', '=', event.ownerSubject)
    .execute();

  const dedupeKey = dedupeKeyFor(event);
  const eventId = `${event.source}/${event.type}`;
  const started: string[] = [];
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
    if (!matchesTriggerEvent(eventId, config.match, event.payload)) continue;
    if (!isAgentStepsDoc(trigger.steps)) continue;

    // The firing lock: one run per (trigger, source event), across every
    // worker process. Whoever wins this INSERT creates the run; a lost
    // conflict means another process (or a replay of this delivery, or a
    // duplicate webhook registration's second delivery) already did.
    if (dedupeKey) {
      const claimed = await db
        .insertInto('agent_trigger_firings')
        .values({
          trigger_id: trigger.trigger_id,
          dedupe_key: dedupeKey,
          tenant_id: event.tenantId,
          run_id: null,
        })
        .onConflict((oc) => oc.columns(['trigger_id', 'dedupe_key']).doNothing())
        .returning('trigger_id')
        .executeTakeFirst();
      if (!claimed) continue;
    }

    const result = await createAgentRun(db, producer, {
      tenantId: event.tenantId,
      agentId: trigger.agent_id,
      ownerSubject: trigger.owner_subject,
      steps: trigger.steps,
      llmModelId: trigger.llm_model_id,
      triggerId: trigger.trigger_id,
      triggerKind: 'event',
      initialState: event.payload,
    });
    if (result.ok) {
      started.push(result.val.runId);
      if (dedupeKey) {
        await db
          .updateTable('agent_trigger_firings')
          .set({ run_id: result.val.runId })
          .where('trigger_id', '=', trigger.trigger_id)
          .where('dedupe_key', '=', dedupeKey)
          .execute();
      }
      await db
        .updateTable('agent_triggers')
        .set({ last_fired_at: sql`NOW()`, last_error: null, updated_at: sql`NOW()` })
        .where('id', '=', trigger.trigger_id)
        .execute();
    } else {
      // Release the claim so a redelivery may retry what a cap or outage
      // refused — mirrors createAgentRun's own "better no trace than a
      // phantom" cleanup.
      if (dedupeKey) {
        await db
          .deleteFrom('agent_trigger_firings')
          .where('trigger_id', '=', trigger.trigger_id)
          .where('dedupe_key', '=', dedupeKey)
          .execute();
      }
      // A refused run (cap, cycle) is the trigger's news to carry, never
      // the pipeline's to fail on.
      await db
        .updateTable('agent_triggers')
        .set({
          last_error: result.err.message ?? `The run could not be started (${result.err.type}).`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', trigger.trigger_id)
        .execute();
    }
  }
  return started;
}
