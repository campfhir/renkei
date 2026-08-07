/**
 * The events-queue consumer side: claim, complete, retry, dead-letter.
 *
 * The queue is the Postgres `events` table (migration 013). Producers INSERT;
 * this module is the only reader. Claims use FOR UPDATE SKIP LOCKED so any
 * number of worker processes compete safely, and the claim query doubles as
 * crash recovery: a `processing` row whose lock is stale is a dead worker's
 * orphan and is claimable again.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import type { Json } from '@renkei/db';
import { failureDisposition, type Disposition } from './policy';

export { failureDisposition, MAX_ATTEMPTS, type Disposition } from './policy';

/** How long a claim may be held before it counts as abandoned. */
const STALE_CLAIM_MINUTES = 10;

export interface ClaimedEvent {
  id: string;
  tenant_id: string;
  source: string;
  type: string;
  payload: Json;
  /** Attempt number of THIS run (already incremented by the claim). */
  attempts: number;
}

/**
 * Claim the oldest ready event, or null when the queue is empty. The claim
 * increments `attempts`, so a crash between claim and completion still
 * consumes an attempt — an event that kills its worker must not retry forever.
 */
export async function claimNextEvent(): Promise<ClaimedEvent | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  const result = await sql<ClaimedEvent>`
    UPDATE events
    SET status = 'processing', locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
    WHERE id = (
      SELECT id FROM events
      WHERE (status = 'pending' AND run_after <= NOW())
         OR (status = 'processing' AND locked_at < NOW() - INTERVAL '${sql.raw(String(STALE_CLAIM_MINUTES))} minutes')
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, source, type, payload, attempts
  `.execute(dbResult.val);

  return result.rows[0] ?? null;
}

export async function completeEvent(id: string): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  await dbResult.val
    .updateTable('events')
    .set({ status: 'processed', locked_at: null, updated_at: sql`NOW()` })
    .where('id', '=', id)
    .execute();
}

export async function failEvent(event: ClaimedEvent, error: string): Promise<Disposition> {
  const disposition = failureDisposition(event.attempts);
  const dbResult = getDatabase();
  if (!dbResult.ok) return disposition;

  const db = dbResult.val;
  if (disposition.status === 'dead') {
    await db
      .updateTable('events')
      .set({ status: 'dead', locked_at: null, last_error: error, updated_at: sql`NOW()` })
      .where('id', '=', event.id)
      .execute();
  } else {
    await db
      .updateTable('events')
      .set({
        status: 'pending',
        locked_at: null,
        last_error: error,
        run_after: sql`NOW() + INTERVAL '${sql.raw(String(disposition.delaySeconds))} seconds'`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', event.id)
      .execute();
  }
  return disposition;
}
