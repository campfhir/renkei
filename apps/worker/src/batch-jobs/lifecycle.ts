/**
 * What happens when a batch changes state — the two audiences a batch has
 * beyond its own row, announced from one place so they can never drift:
 *
 *   1. THE OWNER. A notification row (the feed, the toast pile, the push
 *      that wakes a phone) and, where their Preferences ask for it, an
 *      Outlook mail or a WebEx note — the run-event pattern applied to
 *      batches, gated by `batchStarted`/`batchFinished`/`batchFailed`.
 *      A scheduled batch's owner is the schedule's owner: `createBatch`
 *      copies the subject over, so nothing here has to know whether a
 *      batch was started by hand or by the sweep.
 *
 *   2. AGENTS. A `batch/job.started` or `batch/job.completed` domain event
 *      on the events queue, which the interactive worker's dispatch fans
 *      out to the owner's event triggers (@renkei/agents trigger-catalog).
 *      This is how "OCR the folder overnight, then have an agent file what
 *      it produced into OnBase" chains without anything polling: the
 *      completion event carries the batch id, and the agent reads the
 *      staged documents out of the sandbox under it.
 *
 * ## Exactly once, and best-effort
 *
 * The caller passes the row the store handed back from a terminal
 * transition — and the store hands one back only to the single call that
 * actually made the transition (see `recordItemOutcome`'s guarded flip).
 * So a redelivered message or a concurrent finisher never reaches this
 * module with the same batch twice; the announcement inherits the store's
 * exactly-once without a second lock.
 *
 * The other side of that coin: by the time this runs, the transition has
 * happened, and a redelivery of the queue message would find the batch
 * terminal and do nothing. A failure here therefore cannot be retried by
 * throwing — it would only lose the event later instead of now — so every
 * step is a WARN and carries on. The batch page is the record; this is
 * reach.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { batchEventForStatus, getNotificationPrefs, type BatchEvent } from '@renkei/user-prefs';
import { batchKindLabel, describeBatchOutcome, type BatchJobRow } from '@renkei/batch-jobs-store';
import { publishDomainEvent } from '../domain-events';
import { deliverToOwnerChannels } from '../handlers/owner-channels';
import { registrationUrl } from '../handlers/feed-url';
import { logger } from '../logger';

const COMPONENT = 'batch-jobs/lifecycle';

/** The `connector` a batch notification row wears, for grouping in the feed. */
export const BATCH_JOBS_CONNECTOR = 'batch-jobs';

export type BatchPhase = 'started' | 'completed';

/**
 * The structured half of a batch notification (`agent_notifications.meta`,
 * migration 088) — what the feed renders beside the headline: the kind as
 * a label, the counts, the status pill, and the batch id the row links to.
 * Mirrored by apps/web/lib/notifications/batch-meta.ts, which parses it
 * back; change both together.
 */
export interface BatchNotificationMeta {
  batchId: string;
  kind: string;
  kindLabel: string;
  name: string;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  error: string | null;
  scheduleId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export function batchNotificationMeta(batch: BatchJobRow): BatchNotificationMeta {
  return {
    batchId: batch.id,
    kind: batch.kind,
    kindLabel: batchKindLabel(batch.kind),
    name: batch.name,
    status: batch.status,
    total: batch.total,
    succeeded: batch.succeeded,
    failed: batch.failed,
    error: batch.last_error,
    scheduleId: batch.schedule_id,
    startedAt: batch.started_at ? batch.started_at.toISOString() : null,
    finishedAt: batch.finished_at ? batch.finished_at.toISOString() : null,
  };
}

/**
 * The `trigger.*` variables the catalog promises for each batch event —
 * every key here is a `provides` entry on the matching TRIGGER_EVENT_CATALOG
 * row, and the filters compare `kind`, `status` and `name` as strings.
 * Numbers stay numbers: the engine renders them, and an agent asked to
 * "retry if failed > 0" reads them more naturally that way.
 */
export function batchEventData(batch: BatchJobRow, phase: BatchPhase): Record<string, unknown> {
  const identity = {
    batchId: batch.id,
    name: batch.name,
    kind: batch.kind,
    kindLabel: batchKindLabel(batch.kind),
    scheduleId: batch.schedule_id ?? '',
  };
  if (phase === 'started') return identity;
  return {
    ...identity,
    status: batch.status,
    total: batch.total ?? 0,
    succeeded: batch.succeeded,
    failed: batch.failed,
    summary: describeBatchOutcome(batch),
    error: batch.total === null ? (batch.last_error ?? '') : '',
  };
}

/** The feed row's kind: 'partial' is a finish with news in it, not a failure. */
function notificationKindFor(batch: BatchJobRow, phase: BatchPhase): string {
  if (phase === 'started') return 'batch_started';
  return batch.status === 'failed' ? 'batch_failed' : 'batch_finished';
}

function headlineFor(batch: BatchJobRow, phase: BatchPhase): string {
  const name = `“${batch.name}”`;
  if (phase === 'started') return `${name} started`;
  const outcome = describeBatchOutcome(batch);
  switch (batch.status) {
    case 'failed':
      return `${name} failed: ${outcome}`;
    case 'partial':
      return `${name} finished with failures: ${outcome}`;
    default:
      return `${name} finished: ${outcome}`;
  }
}

async function publish(batch: BatchJobRow, phase: BatchPhase): Promise<void> {
  const at = phase === 'started' ? batch.started_at : batch.finished_at;
  try {
    await publishDomainEvent({
      tenantId: batch.tenant_id,
      provider: 'batch',
      type: phase === 'started' ? 'job.started' : 'job.completed',
      ownerSubject: batch.subject,
      data: batchEventData(batch, phase),
      occurredAt: at ? at.toISOString() : new Date().toISOString(),
      orderingKey: `batch/${batch.id}`,
    });
  } catch (error) {
    logger.warn('batch {batchJobId} {phase} event not published: {error}', {
      component: COMPONENT,
      tenantId: batch.tenant_id,
      batchJobId: batch.id,
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function notifyOwner(db: Kysely<DB>, batch: BatchJobRow, phase: BatchPhase): Promise<void> {
  const prefs = await getNotificationPrefs(batch.tenant_id, batch.subject);
  const key: BatchEvent = phase === 'started' ? 'batchStarted' : batchEventForStatus(batch.status);
  const wanted = prefs[key];
  if (!wanted.app && !wanted.email && !wanted.webex) return;

  const headline = headlineFor(batch, phase);
  const kindLabel = batchKindLabel(batch.kind);

  if (wanted.app) {
    const id = randomUUID();
    try {
      await db
        .insertInto('agent_notifications')
        .values({
          id,
          tenant_id: batch.tenant_id,
          subject: batch.subject,
          kind: notificationKindFor(batch, phase),
          connector: BATCH_JOBS_CONNECTOR,
          entity: 'batch',
          headline,
          ref_id: batch.name,
          meta: JSON.stringify(batchNotificationMeta(batch)),
        })
        .execute();

      // Fire-and-forget, the same reasoning as worker-agents' write(): a
      // push service's latency must never add to the batch handler's, and
      // the row above is already the record.
      const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
      if (keyResult.ok) {
        void sendPush(
          db,
          batch.tenant_id,
          batch.subject,
          keyResult.val,
          { title: headline, body: kindLabel, tag: `batch:${batch.id}`, refUrl: null },
          { log: (message, meta) => logger.warn(message, meta) }
        );
      }
    } catch (error) {
      logger.warn('could not record a notification for batch {batchJobId}: {error}', {
        component: COMPONENT,
        tenantId: batch.tenant_id,
        batchJobId: batch.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (wanted.email || wanted.webex) {
    const base = await registrationUrl(batch.tenant_id);
    const link = base ? `${base}/batch-jobs/${batch.id}` : null;
    const body =
      `${kindLabel} batch “${batch.name}” ${phase === 'started' ? 'started' : describeBatchOutcome(batch)}.` +
      (link ? `\n\nSee the batch: ${link}` : '');
    await deliverToOwnerChannels(db, {
      tenantId: batch.tenant_id,
      ownerSubject: batch.subject,
      email: wanted.email,
      webex: wanted.webex,
      heading: headline,
      body,
      log: { component: COMPONENT, batchJobId: batch.id },
    });
  }
}

async function announce(db: Kysely<DB>, batch: BatchJobRow, phase: BatchPhase): Promise<void> {
  // Agents first: the event is the cheaper, more consequential half — a
  // chained agent waiting on it should not queue behind a mail send.
  await publish(batch, phase);
  try {
    await notifyOwner(db, batch, phase);
  } catch (error) {
    logger.warn('could not notify the owner of batch {batchJobId}: {error}', {
      component: COMPONENT,
      tenantId: batch.tenant_id,
      batchJobId: batch.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Call with the row `beginDiscovery` returned — the batch has just begun work. */
export async function announceBatchStarted(db: Kysely<DB>, batch: BatchJobRow): Promise<void> {
  await announce(db, batch, 'started');
}

/**
 * Call with the row a terminal transition returned (`failBatch`,
 * `completeEmptyBatch`, or `recordItemOutcome` when it finalized) — never
 * with a row read back afterwards, which is how a batch would get
 * announced twice.
 */
export async function announceBatchFinished(db: Kysely<DB>, batch: BatchJobRow): Promise<void> {
  await announce(db, batch, 'completed');
}
