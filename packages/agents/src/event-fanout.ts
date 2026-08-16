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

export interface AgentEventInput {
  tenantId: string;
  /** Catalog source/type, e.g. 'microsoft' / 'mail.received'. */
  source: string;
  type: string;
  /** The subject the event belongs to — only their agents fire. */
  ownerSubject: string;
  /** Becomes trigger.* variables; keys must match the catalog's provides. */
  payload: Record<string, unknown>;
}

interface MatchFilters {
  fromDomain?: string;
  subjectContains?: string;
}

function matches(filters: MatchFilters, payload: Record<string, unknown>): boolean {
  if (filters.fromDomain) {
    const from = typeof payload.from === 'string' ? payload.from : '';
    if (!from.toLowerCase().endsWith(`@${filters.fromDomain.toLowerCase()}`)) return false;
  }
  if (filters.subjectContains) {
    const subject = typeof payload.subject === 'string' ? payload.subject : '';
    if (!subject.toLowerCase().includes(filters.subjectContains.toLowerCase())) return false;
  }
  return true;
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

  const started: string[] = [];
  for (const trigger of triggers) {
    const config: { match?: MatchFilters } =
      typeof trigger.config === 'object' &&
      trigger.config !== null &&
      !Array.isArray(trigger.config)
        ? trigger.config
        : {};
    if (!matches(config.match ?? {}, event.payload)) continue;
    if (!isAgentStepsDoc(trigger.steps)) continue;

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
      await db
        .updateTable('agent_triggers')
        .set({ last_fired_at: sql`NOW()`, last_error: null, updated_at: sql`NOW()` })
        .where('id', '=', trigger.trigger_id)
        .execute();
    } else {
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
