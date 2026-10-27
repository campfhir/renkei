/**
 * The agent_jobs half of force-halt.ts: making sure no queue row can ever
 * resume or double-process a run that was closed out from under it.
 *
 * This is queue plumbing, not run state — it belongs with @renkei/queue's
 * agent-jobs helpers and moves there when that package goes through the
 * data store; until then it is the one place the web app touches the
 * agent_jobs tables directly.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';

/**
 * Skip the run's live agent_jobs row (pending or processing) and drop its
 * dead letters. Bypasses the janitor's live-job check on purpose — that
 * safety check is exactly what makes the force-halt override necessary in
 * the first place. A row still 'processing' is treated the same as a
 * 'pending' one: it just never gets claimed again.
 */
export async function discardRunJobs(runId: string): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  const db = dbResult.val;
  await db
    .updateTable('agent_jobs')
    .set({ status: 'skipped', locked_at: null, updated_at: sql`NOW()` })
    .where('status', 'in', ['pending', 'processing'])
    .where(sql<string>`payload->>'runId'`, '=', runId)
    .execute();
  await db
    .deleteFrom('agent_jobs_dead_letters')
    .where(sql<string>`payload->>'runId'`, '=', runId)
    .execute();
}
