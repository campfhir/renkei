/**
 * The in-memory adapter: the full queue contract — leases, backoff,
 * ordering keys, dead-letter move/requeue — with arrays instead of tables.
 *
 * It exists for two reasons. It is the test double for anything that
 * consumes a Queue (the worker's synthetic multi-stream suite runs both
 * worker loops against it), and it is the proof that the contract really
 * is adapter-agnostic: nothing that compiles against `Queue` can tell this
 * from Postgres — which is exactly the property a future RabbitMQ or
 * Kafka adapter relies on.
 *
 * Claim semantics mirror postgres.ts line for line: oldest deliverable
 * message first, where deliverable means due (pending and past run_after,
 * or processing with an expired lease) AND, for keyed messages, no older
 * live sibling with the same ordering key.
 */

import { randomUUID } from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { ClaimedMessage, DeadLetter, Disposition, Queue, QueueMessageInput } from './contract';
import { failureDisposition, DEFAULT_RETRY_POLICY, type RetryPolicy } from './policy';

export type MemoryMessageStatus = 'pending' | 'processing' | 'processed';

export interface MemoryMessage {
  id: string;
  tenant_id: string;
  source: string;
  type: string;
  payload: ClaimedMessage['payload'];
  orderingKey: string | null;
  status: MemoryMessageStatus;
  attempts: number;
  runAfter: number;
  lockedAt: number | null;
  lastError: string | null;
  /** Enqueue order, the created_at analog — monotonic per queue instance. */
  seq: number;
  insertedAt: number;
  completedAt: number | null;
}

export interface InMemoryQueueOptions {
  policy?: RetryPolicy;
  /** Delivery lease in ms; an expired lease makes the message reclaimable. */
  leaseMs?: number;
  /** Restrict this consumer to these sources (postgres.ts's `sources`). */
  sources?: readonly string[];
  /** Even claims across sources (postgres.ts's `fairAcrossSources`). */
  fairAcrossSources?: boolean;
  /** Source-pick randomness, injectable so fairness tests are deterministic. */
  random?: () => number;
}

export class InMemoryQueue implements Queue {
  private readonly rows: MemoryMessage[] = [];
  private readonly deadRows: DeadLetter[] = [];
  private readonly policy: RetryPolicy;
  private readonly leaseMs: number;
  private readonly sources?: readonly string[];
  private readonly fairAcrossSources: boolean;
  private readonly random: () => number;
  private seq = 0;

  constructor(options: InMemoryQueueOptions = {}) {
    this.policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.sources = options.sources;
    this.fairAcrossSources = options.fairAcrossSources ?? false;
    this.random = options.random ?? Math.random;
  }

  readonly producer = {
    enqueue: async (message: QueueMessageInput) => {
      this.rows.push({
        id: randomUUID(),
        tenant_id: message.tenantId,
        source: message.source,
        type: message.type,
        // The same round-trip a jsonb column performs.
        payload: JSON.parse(JSON.stringify(message.payload)),
        orderingKey: message.orderingKey ?? null,
        status: 'pending',
        attempts: 0,
        runAfter: 0,
        lockedAt: null,
        lastError: null,
        seq: this.seq++,
        insertedAt: Date.now(),
        completedAt: null,
      });
      return ok();
    },
  };

  readonly consumer = {
    claim: async (): Promise<ClaimedMessage | null> => {
      const now = Date.now();
      const due = (row: MemoryMessage): boolean =>
        (row.status === 'pending' && row.runAfter <= now) ||
        (row.status === 'processing' && (row.lockedAt ?? 0) < now - this.leaseMs);
      const live = (row: MemoryMessage): boolean =>
        row.status === 'pending' || row.status === 'processing';

      const deliverable = this.rows
        .filter(due)
        .filter((candidate) => !this.sources || this.sources.includes(candidate.source))
        .filter(
          (candidate) =>
            candidate.orderingKey === null ||
            !this.rows.some(
              (sibling) =>
                sibling.orderingKey === candidate.orderingKey &&
                live(sibling) &&
                sibling.seq < candidate.seq
            )
        )
        .sort((a, b) => a.seq - b.seq);

      // The fair pick over the exact deliverable set — where postgres.ts
      // approximates with due-only sources plus an oldest-first fallback,
      // arrays can afford the precise version of the same semantics.
      let row: MemoryMessage | undefined = deliverable[0];
      if (this.fairAcrossSources && deliverable.length > 0) {
        const distinctSources = [...new Set(deliverable.map((r) => r.source))].sort();
        const picked = distinctSources[Math.floor(this.random() * distinctSources.length)]!;
        row = deliverable.find((r) => r.source === picked);
      }
      if (!row) return null;

      row.status = 'processing';
      row.lockedAt = now;
      row.attempts += 1;
      return {
        id: row.id,
        tenant_id: row.tenant_id,
        source: row.source,
        type: row.type,
        payload: row.payload,
        attempts: row.attempts,
      };
    },

    complete: async (message: ClaimedMessage): Promise<void> => {
      const row = this.rows.find((r) => r.id === message.id);
      if (!row) return;
      row.status = 'processed';
      row.lockedAt = null;
      row.completedAt = Date.now();
    },

    fail: async (message: ClaimedMessage, error: string): Promise<Disposition> => {
      const disposition = failureDisposition(message.attempts, this.policy);
      const index = this.rows.findIndex((r) => r.id === message.id);
      if (index === -1) return disposition;
      const row = this.rows[index]!;
      if (disposition.status === 'dead') {
        this.rows.splice(index, 1);
        this.deadRows.push({
          id: row.id,
          tenant_id: row.tenant_id,
          source: row.source,
          type: row.type,
          payload: row.payload,
          orderingKey: row.orderingKey,
          attempts: row.attempts,
          lastError: error,
          deadAt: new Date(),
        });
      } else {
        row.status = 'pending';
        row.lockedAt = null;
        row.lastError = error;
        row.runAfter = Date.now() + disposition.delaySeconds * 1000;
      }
      return disposition;
    },
  };

  /**
   * The same contract as Postgres: pending only, every predicate must match.
   * Kept in step so a test proving a rebuild discards its superseded work
   * exercises the real semantics rather than a stub that always returns 0.
   */
  readonly purger = {
    discardPending: async (
      tenantId: string,
      type: string,
      match: readonly { path: readonly string[]; value: string }[]
    ) => {
      if (match.length === 0) {
        return err('QUEUE_ERROR' as const, { message: 'discardPending needs a predicate' });
      }
      const matches = (payload: unknown, path: readonly string[]): string | null => {
        let node: unknown = payload;
        for (const step of path) {
          if (typeof node !== 'object' || node === null) return null;
          // Reflect.get rather than an indexed assertion: the repo bans `as`,
          // and this walks untyped JSON where a wrong shape must return null
          // rather than be asserted into existence.
          node = Reflect.get(node, step);
        }
        return typeof node === 'string' ? node : null;
      };

      let removed = 0;
      for (let i = this.rows.length - 1; i >= 0; i -= 1) {
        const row = this.rows[i];
        if (!row || row.tenant_id !== tenantId || row.type !== type) continue;
        if (row.status !== 'pending') continue;
        if (!match.every((entry) => matches(row.payload, entry.path) === entry.value)) continue;
        this.rows.splice(i, 1);
        removed += 1;
      }
      return ok(removed);
    },
  };

  readonly deadLetters = {
    list: async (options: { limit?: number } = {}) =>
      ok(
        [...this.deadRows]
          .sort((a, b) => b.deadAt.getTime() - a.deadAt.getTime())
          .slice(0, options.limit ?? 100)
      ),

    requeue: async (ids: readonly string[]) => {
      let moved = 0;
      for (const id of ids) {
        const index = this.deadRows.findIndex((row) => row.id === id);
        if (index === -1) continue;
        const dead = this.deadRows.splice(index, 1)[0]!;
        this.rows.push({
          id: dead.id,
          tenant_id: dead.tenant_id,
          source: dead.source,
          type: dead.type,
          payload: dead.payload,
          orderingKey: dead.orderingKey,
          status: 'pending',
          attempts: 0,
          runAfter: 0,
          lockedAt: null,
          lastError: dead.lastError,
          seq: this.seq++,
          insertedAt: Date.now(),
          completedAt: null,
        });
        moved += 1;
      }
      return ok(moved);
    },

    purge: async (ids: readonly string[]) => {
      let dropped = 0;
      for (const id of ids) {
        const index = this.deadRows.findIndex((row) => row.id === id);
        if (index === -1) continue;
        this.deadRows.splice(index, 1);
        dropped += 1;
      }
      return ok(dropped);
    },
  };

  // ——— test-observability helpers, not part of the Queue contract ———

  snapshot(): readonly MemoryMessage[] {
    return this.rows.map((row) => ({ ...row }));
  }

  deadSnapshot(): readonly DeadLetter[] {
    return this.deadRows.map((row) => ({ ...row }));
  }

  /** True once nothing is live: every message processed or dead-lettered. */
  settled(): boolean {
    return this.rows.every((row) => row.status === 'processed');
  }
}
