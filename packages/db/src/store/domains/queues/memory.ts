import { compareAsc, orderBy } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import type { QueueClaimOptions, QueueDeadLetterTable, QueueStore, QueueTable } from './types';

const DEAD_LETTERS: Record<QueueTable, QueueDeadLetterTable> = {
  events: 'events_dead_letters',
  embedding_jobs: 'embedding_jobs_dead_letters',
  agent_jobs: 'agent_jobs_dead_letters',
  batch_job_messages: 'batch_job_messages_dead_letters',
};

type LiveRow = Row<QueueTable>;

/** Pending past run_after, or processing under a lease older than the stale horizon. */
function isDue(row: LiveRow, now: number, options: QueueClaimOptions): boolean {
  if (row.status === 'pending') return row.run_after.getTime() <= now;
  if (row.status === 'processing') {
    return (
      row.locked_at !== null && row.locked_at.getTime() < now - options.staleClaimMinutes * 60_000
    );
  }
  return false;
}

function inSources(row: LiveRow, options: QueueClaimOptions): boolean {
  return !options.sources || options.sources.length === 0 || options.sources.includes(row.source);
}

/** `(a.created_at, a.id) < (b.created_at, b.id)`. */
function olderThan(a: LiveRow, b: LiveRow): boolean {
  const byTime = compareAsc(a.created_at, b.created_at);
  return byTime !== 0 ? byTime < 0 : compareAsc(a.id, b.id) < 0;
}

/** `payload #>> path`: the value at the path as text, null where the path leads nowhere. */
function textAt(payload: unknown, path: readonly string[]): string | null {
  let current: unknown = payload;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^-?\d+$/.test(segment)) return null;
      const index = Number(segment);
      current = current[index < 0 ? current.length + index : index];
    } else if (typeof current === 'object' && current !== null) {
      current = Reflect.get(current, segment);
    } else return null;
    if (current === undefined) return null;
  }
  if (current === null) return null;
  return typeof current === 'string' ? current : JSON.stringify(current);
}

export function memoryQueues(tables: MemoryTables): QueueStore {
  return {
    async enqueue(table, message) {
      const key = message.orderingKey ?? null;
      if (message.coalesce && key !== null) {
        const waiting = tables.first(
          table,
          (r) =>
            r.source === message.source &&
            r.type === message.type &&
            r.ordering_key === key &&
            r.status === 'pending'
        );
        if (waiting) return;
      }
      tables.insert(table, {
        id: globalThis.crypto.randomUUID(),
        source: message.source,
        type: message.type,
        payload: JSON.stringify(message.payload),
        ordering_key: key,
      });
    },
    async discardPending(table, type, match) {
      if (match.length === 0) throw new Error('discardPending needs a predicate');
      return tables.delete(
        table,
        (r) =>
          r.type === type &&
          r.status === 'pending' &&
          match.every((entry) => textAt(r.payload, entry.path) === entry.value)
      ).length;
    },
    async listPending(table) {
      const rows = tables.select(table, (r) => r.status === 'pending');
      return orderBy(rows, [(r) => r.created_at], [(r) => r.id]).map((row) => ({
        source: row.source,
        type: row.type,
        payload: row.payload,
        orderingKey: row.ordering_key,
      }));
    },
    async discardAgentRunJobs(runId) {
      const ofRun = (payload: unknown) => textAt(payload, ['runId']) === runId;
      const skipped = tables.update(
        'agent_jobs',
        (r) => (r.status === 'pending' || r.status === 'processing') && ofRun(r.payload),
        { status: 'skipped', locked_at: null, updated_at: new Date() }
      ).length;
      const deadLetters = tables.delete('agent_jobs_dead_letters', (r) => ofRun(r.payload)).length;
      return { skipped, deadLetters };
    },

    // One process, no other consumer to lock out: the claim is a filter,
    // a sort and an update — Postgres's FOR UPDATE SKIP LOCKED, minus the
    // locks there is nobody here to take.
    async claim(table, options) {
      const now = Date.now();
      const rows = tables.select(table);
      const due = rows.filter((r) => isDue(r, now, options) && inSources(r, options));
      if (due.length === 0) return null;
      const deliverable = (pinned: string | null) =>
        orderBy(
          due.filter(
            (c) =>
              (pinned === null || c.source === pinned) &&
              (c.ordering_key === null ||
                !rows.some(
                  (b) =>
                    b.ordering_key === c.ordering_key &&
                    (b.status === 'pending' || b.status === 'processing') &&
                    olderThan(b, c)
                ))
          ),
          [(r) => r.created_at],
          [(r) => r.id]
        )[0];
      let picked: LiveRow | undefined;
      if (options.fairAcrossSources) {
        const sources = [...new Set(due.map((r) => r.source))];
        picked = deliverable(sources[Math.floor(Math.random() * sources.length)]);
      }
      picked ??= deliverable(null);
      if (!picked) return null;
      const at = new Date(now);
      const [claimed] = tables.update(
        table,
        (r) => r.id === picked.id,
        (r) => ({
          status: 'processing',
          locked_at: at,
          attempts: r.attempts + 1,
          updated_at: at,
        })
      );
      if (!claimed) return null;
      return {
        id: claimed.id,
        source: claimed.source,
        type: claimed.type,
        payload: claimed.payload,
        attempts: claimed.attempts,
      };
    },

    async complete(table, id, outcome, options = {}) {
      const key = tables.param(table, 'id', id);
      tables.update(table, (r) => r.id === key, {
        status: outcome,
        locked_at: null,
        updated_at: new Date(),
        ...(options.clearPayload ? { payload: '{}' } : {}),
      });
    },

    async release(table, id, attempts) {
      const key = tables.param(table, 'id', id);
      const at = new Date();
      tables.update(
        table,
        (r) => r.id === key && r.status === 'processing' && r.attempts === attempts,
        (r) => ({
          status: 'pending',
          locked_at: null,
          attempts: Math.max(r.attempts - 1, 0),
          run_after: at,
          updated_at: at,
        })
      );
    },

    async retry(table, id, error, delaySeconds) {
      const key = tables.param(table, 'id', id);
      const at = new Date();
      tables.update(table, (r) => r.id === key, {
        status: 'pending',
        locked_at: null,
        last_error: error,
        run_after: new Date(at.getTime() + delaySeconds * 1000),
        updated_at: at,
      });
    },

    async deadLetter(table, id, error) {
      const key = tables.param(table, 'id', id);
      // Insert, then delete: a collision fails the move with nothing lost.
      for (const row of tables.select(table, (r) => r.id === key)) {
        tables.insert(DEAD_LETTERS[table], {
          id: row.id,
          source: row.source,
          type: row.type,
          payload: JSON.stringify(row.payload),
          ordering_key: row.ordering_key,
          attempts: row.attempts,
          last_error: error,
          created_at: row.created_at,
        });
      }
      tables.delete(table, (r) => r.id === key);
    },

    async find(table, id) {
      const key = tables.param(table, 'id', id);
      const row = tables.first(table, (r) => r.id === key);
      if (!row) return null;
      return {
        id: row.id,
        source: row.source,
        type: row.type,
        payload: row.payload,
        orderingKey: row.ordering_key,
        status: row.status,
        attempts: row.attempts,
        runAfter: row.run_after,
        lockedAt: row.locked_at,
        lastError: row.last_error,
        createdAt: row.created_at,
      };
    },

    async listDeadLetters(table, limit) {
      const rows = orderBy(
        tables.select(DEAD_LETTERS[table]),
        [(r) => r.dead_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      return rows.slice(0, limit).map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        payload: row.payload,
        orderingKey: row.ordering_key,
        attempts: row.attempts,
        lastError: row.last_error,
        deadAt: row.dead_at,
      }));
    },

    async requeueDeadLetters(table, ids) {
      if (ids.length === 0) return 0;
      const keys = new Set(ids.map((id) => tables.param(table, 'id', id)));
      // Insert first, then delete: a collision with a live row fails the
      // whole move with nothing lost, as the one Postgres statement does.
      const moved = tables.select(DEAD_LETTERS[table], (r) => keys.has(r.id));
      const at = new Date();
      tables.insertMany(
        table,
        moved.map((row) => ({
          id: row.id,
          source: row.source,
          type: row.type,
          payload: JSON.stringify(row.payload),
          ordering_key: row.ordering_key,
          status: 'pending',
          attempts: 0,
          run_after: at,
          created_at: row.created_at,
        }))
      );
      tables.delete(DEAD_LETTERS[table], (r) => keys.has(r.id));
      return moved.length;
    },

    async purgeDeadLetters(table, ids) {
      if (ids.length === 0) return 0;
      const keys = new Set(ids.map((id) => tables.param(table, 'id', id)));
      return tables.delete(DEAD_LETTERS[table], (r) => keys.has(r.id)).length;
    },
    async hasLiveAgentRunJob(runId) {
      return (
        tables.first(
          'agent_jobs',
          (r) =>
            (r.status === 'pending' || r.status === 'processing') &&
            textAt(r.payload, ['runId']) === runId
        ) !== undefined
      );
    },
  };
}
