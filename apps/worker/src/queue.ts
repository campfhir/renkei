/**
 * The worker's queues, constructed from @renkei/queue's Postgres adapter
 * (Decision #20): `events` — webhook/interactive traffic — `embedding_jobs`
 * — everything that talks to the org-configured embeddings endpoint — and
 * `batch_job_messages` — per-item fan-out for batch jobs (document-ocr-pipeline
 * and future kinds), consumed by the dedicated batch-jobs-worker entrypoint.
 * Row-locked claims (FOR UPDATE SKIP LOCKED) let any number of worker
 * instances consume any queue; ordering keys keep purge/ingest/delete
 * sequences serial where producers asked for it.
 *
 * `ClaimedEvent` is the historical name for the queue package's
 * ClaimedMessage — re-exported so the handler modules stay
 * adapter-agnostic.
 */

import { webhookEventsQueue, embeddingJobsQueue, batchJobsQueue } from '@renkei/queue';
import type { Queue } from '@renkei/queue';

export type { ClaimedMessage as ClaimedEvent, Disposition } from '@renkei/queue';

/**
 * WORKER_EVENT_SOURCES fixates THIS worker instance on a comma-separated
 * list of event sources ('webex,zoom'). Unset, the instance consumes every
 * source — claims are already fair across sources either way; fixation is
 * for dedicating whole instances (e.g. one container that only serves chat
 * while another drains the rest).
 *
 * Each listed source implies its `domain:{source}` lane too: a provider
 * handler ends by publishing a domain event (domain-events.ts), and an
 * instance fixated on the provider must also dispatch what it publishes —
 * otherwise its events would pile up waiting for an unfixated sibling.
 *
 * A fixated deployment must also list 'mailjobs' on SOME instance — the
 * async Outlook bulk mail jobs (handlers/mail-bulk-jobs.ts) arrive on that
 * source, and nothing else drains it.
 */
function eventSourcesFromEnv(): readonly string[] | undefined {
  const raw = process.env.WORKER_EVENT_SOURCES;
  if (!raw) return undefined;
  const sources = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return sources.length > 0 ? sources.flatMap((s) => [s, `domain:${s}`]) : undefined;
}

export const eventsQueue: Queue = webhookEventsQueue({ sources: eventSourcesFromEnv() });
export const embeddingQueue: Queue = embeddingJobsQueue();
export const batchJobQueue: Queue = batchJobsQueue();
