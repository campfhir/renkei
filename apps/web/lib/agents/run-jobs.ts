/**
 * The agent_jobs half of force-halt.ts: making sure no queue row can ever
 * resume or double-process a run that was closed out from under it.
 *
 * Queue plumbing, not run state: the work is the data store's
 * `queues.discardAgentRunJobs`, one transaction on Postgres.
 */

import { getDataStore } from '@renkei/db';

/**
 * Skip the run's live agent_jobs row (pending or processing) and drop its
 * dead letters. Bypasses the janitor's live-job check on purpose — that
 * safety check is exactly what makes the force-halt override necessary in
 * the first place. A row still 'processing' is treated the same as a
 * 'pending' one: it just never gets claimed again.
 */
export async function discardRunJobs(runId: string): Promise<void> {
  await getDataStore().queues.discardAgentRunJobs(runId);
}
