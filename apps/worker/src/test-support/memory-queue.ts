/**
 * An in-memory stand-in for the events table implementing the same lane
 * semantics as queue.ts — FIFO by insertion within a lane, `run_after`
 * respected, `attempts` incremented at claim, failure dispositions from the
 * real (pure) policy module. The synthetic multi-stream suite runs both
 * worker loops against one of these to prove lane isolation without a live
 * Postgres; the SQL claim query itself is covered by the manual checklist
 * in DEPLOYMENT.md.
 */

import type { ClaimedEvent, Disposition, EventLane } from '../queue';
import { failureDisposition } from '../policy';

export type MemoryEventStatus = 'pending' | 'processing' | 'processed' | 'dead';

export interface MemoryEvent {
  id: string;
  tenant_id: string;
  source: string;
  type: string;
  payload: ClaimedEvent['payload'];
  lane: EventLane;
  status: MemoryEventStatus;
  attempts: number;
  runAfter: number;
  lastError: string | null;
  insertedAt: number;
  completedAt: number | null;
}

export interface MemoryEventInput {
  id: string;
  tenant_id: string;
  source: string;
  type: string;
  payload: ClaimedEvent['payload'];
}

export class InMemoryEventQueue {
  private readonly rows: MemoryEvent[] = [];

  insert(input: MemoryEventInput, lane: EventLane): MemoryEvent {
    const row: MemoryEvent = {
      ...input,
      lane,
      status: 'pending',
      attempts: 0,
      runAfter: 0,
      lastError: null,
      insertedAt: Date.now(),
      completedAt: null,
    };
    this.rows.push(row);
    return row;
  }

  async claim(lane: EventLane): Promise<ClaimedEvent | null> {
    const now = Date.now();
    const row = this.rows.find(
      (r) => r.lane === lane && r.status === 'pending' && r.runAfter <= now
    );
    if (!row) return null;
    row.status = 'processing';
    row.attempts += 1;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      source: row.source,
      type: row.type,
      payload: row.payload,
      attempts: row.attempts,
    };
  }

  async complete(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = 'processed';
    row.completedAt = Date.now();
  }

  async fail(event: ClaimedEvent, error: string): Promise<Disposition> {
    const disposition = failureDisposition(event.attempts);
    const row = this.rows.find((r) => r.id === event.id);
    if (row) {
      row.lastError = error;
      if (disposition.status === 'dead') {
        row.status = 'dead';
      } else {
        row.status = 'pending';
        row.runAfter = Date.now() + disposition.delaySeconds * 1000;
      }
    }
    return disposition;
  }

  snapshot(): readonly MemoryEvent[] {
    return this.rows.map((row) => ({ ...row }));
  }

  lane(lane: EventLane): readonly MemoryEvent[] {
    return this.snapshot().filter((row) => row.lane === lane);
  }

  /** True once no row is pending-and-due or processing. */
  settled(): boolean {
    return this.rows.every((row) => row.status === 'processed' || row.status === 'dead');
  }
}
