/**
 * The worker's two queues, constructed from @renkei/queue's Postgres
 * adapter (Decision #20): `events` — webhook/interactive traffic — and
 * `embedding_jobs` — everything that talks to the org-configured
 * embeddings endpoint. Row-locked claims (FOR UPDATE SKIP LOCKED) let any
 * number of worker instances consume either queue; ordering keys keep
 * purge/ingest/delete sequences serial where producers asked for it.
 *
 * `ClaimedEvent` is the historical name for the queue package's
 * ClaimedMessage — re-exported so the handler modules stay
 * adapter-agnostic.
 */

import { webhookEventsQueue, embeddingJobsQueue } from '@renkei/queue';
import type { Queue } from '@renkei/queue';

export type { ClaimedMessage as ClaimedEvent, Disposition } from '@renkei/queue';

export const eventsQueue: Queue = webhookEventsQueue();
export const embeddingQueue: Queue = embeddingJobsQueue();
