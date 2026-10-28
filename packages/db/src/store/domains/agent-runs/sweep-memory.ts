import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import type { AgentRunSweepStore } from './sweep-types';

const DECIDED: readonly string[] = ['approved', 'declined', 'expired', 'answered'];
const SETTLED: readonly string[] = ['succeeded', 'failed', 'canceled', 'stopped'];
const IN_PROGRESS: readonly string[] = ['queued', 'running'];
const OPEN: readonly string[] = ['waiting', 'running', 'queued'];

/**
 * What goes with deleted runs: their turn rows, batches, cards and
 * notifications; child runs keep going without a parent.
 */
export function deleteRunRows(tables: MemoryTables, runIds: readonly string[]): void {
  const ids = new Set(runIds);
  tables.delete('agent_run_steps', (r) => ids.has(r.run_id));
  tables.delete('agent_action_batches', (r) => ids.has(r.run_id));
  tables.delete('actionable_items', (r) => r.run_id !== null && ids.has(r.run_id));
  tables.delete('agent_notifications', (r) => r.run_id !== null && ids.has(r.run_id));
  tables.update('agent_runs', (r) => r.parent_run_id !== null && ids.has(r.parent_run_id), {
    parent_run_id: null,
  });
}

export function memoryAgentRunSweeps(tables: MemoryTables): AgentRunSweepStore {
  const expireCard = (reason: string) => {
    const now = new Date();
    return {
      status: 'expired',
      decided_at: now,
      archived_at: now,
      result: toJson({ reason }),
      updated_at: now,
    };
  };
  const ref = (row: { id: string; agent_id: string }) => ({ id: row.id, agentId: row.agent_id });

  return {
    async listDueWaiting(now, limit) {
      const rows = tables.select(
        'agent_runs',
        (r) =>
          r.status === 'waiting' &&
          r.waiting_until !== null &&
          r.waiting_until.getTime() <= now.getTime()
      );
      return page(orderBy(rows, [(r) => r.waiting_until], [(r) => r.id]), limit).map(ref);
    },
    async expireWaitingCard(runId, reason) {
      const run = runId;
      return (
        tables.update(
          'actionable_items',
          (c) => c.run_id === run && c.status === 'suggested',
          expireCard(reason)
        ).length > 0
      );
    },
    async listWaitingWithDecidedCard(decidedBefore, limit) {
      const waiting = new Map(
        tables.select('agent_runs', (r) => r.status === 'waiting').map((r) => [r.id, r])
      );
      const pairs = tables
        .select(
          'actionable_items',
          (c) =>
            c.run_id !== null &&
            waiting.has(c.run_id) &&
            DECIDED.includes(c.status) &&
            c.decided_at !== null &&
            c.decided_at.getTime() <= decidedBefore.getTime()
        )
        .flatMap((c) => {
          const run = c.run_id === null ? undefined : waiting.get(c.run_id);
          return run ? [{ run, cardId: c.id }] : [];
        });
      return page(orderBy(pairs, [(p) => p.run.id], [(p) => p.cardId]), limit).map((p) =>
        ref(p.run)
      );
    },
    async listWaitingWithoutCard(updatedBefore, limit) {
      const carded = new Set(tables.select('actionable_items').map((c) => c.run_id));
      const rows = tables.select(
        'agent_runs',
        (r) =>
          r.status === 'waiting' &&
          !carded.has(r.id) &&
          r.updated_at.getTime() <= updatedBefore.getTime()
      );
      return page(orderBy(rows, [(r) => r.id]), limit).map(ref);
    },
    async expireCardsOfEndedRuns() {
      const open = new Set(
        tables.select('agent_runs', (r) => OPEN.includes(r.status)).map((r) => r.id)
      );
      return tables.update(
        'actionable_items',
        (c) => c.status === 'suggested' && c.run_id !== null && !open.has(c.run_id),
        expireCard('run-ended')
      ).length;
    },
    async pruneFinishedBefore(before, limit) {
      const doomed = new Set(
        page(
          orderBy(
            tables.select(
              'agent_runs',
              (r) => SETTLED.includes(r.status) && r.created_at.getTime() < before.getTime()
            ),
            [(r) => r.created_at],
            [(r) => r.id]
          ),
          limit
        ).map((r) => r.id)
      );
      const deleted = tables.delete('agent_runs', (r) => doomed.has(r.id)).length;
      deleteRunRows(tables, [...doomed]);
      return deleted;
    },
    async listStaleInProgress(createdBefore, limit) {
      const rows = tables.select(
        'agent_runs',
        (r) => IN_PROGRESS.includes(r.status) && r.created_at.getTime() < createdBefore.getTime()
      );
      return page(orderBy(rows, [(r) => r.created_at], [(r) => r.id]), limit).map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        ownerSubject: r.owner_subject,
        startedAt: r.started_at,
      }));
    },
    async failAbandoned(runId, { errorKind, error }) {
      const id = runId;
      const now = new Date();
      return (
        tables.update('agent_runs', (r) => r.id === id && IN_PROGRESS.includes(r.status), {
          status: 'failed',
          error_kind: errorKind,
          error,
          finished_at: now,
          updated_at: now,
        }).length > 0
      );
    },
  };
}
