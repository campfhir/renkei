import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { jsonbConcat, optimizationFromRow, outcomeColumns } from './record';
import type { AgentOptimizationStore } from './types';

export function memoryAgentOptimizations(tables: MemoryTables): AgentOptimizationStore {
  return {
    async create({ ownerSubject, agentId, request }) {
      const now = new Date();
      return tables.insert('agent_optimizations', {
        id: globalThis.crypto.randomUUID(),
        owner_subject: ownerSubject,
        agent_id: agentId,
        status: 'queued',
        request: toJson(request),
        result: null,
        error: null,
        error_detail: null,
        attempts: 0,
        applied_at: null,
        input_tokens: 0,
        output_tokens: 0,
        finished_at: null,
        created_at: now,
        updated_at: now,
      }).id;
    },
    async find(ownerSubject, optimizationId) {
      const id = optimizationId;
      const row = tables.first(
        'agent_optimizations',
        (r) => r.owner_subject === ownerSubject && r.id === id
      );
      return row ? optimizationFromRow(row) : null;
    },
    async latest(ownerSubject, agentId) {
      const agent = agentId;
      const [row] = orderBy(
        tables.select(
          'agent_optimizations',
          (r) => r.owner_subject === ownerSubject && r.agent_id === agent
        ),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return row ? optimizationFromRow(row) : null;
    },
    async inFlight(agentId) {
      const agent = agentId;
      const [row] = orderBy(
        tables.select(
          'agent_optimizations',
          (r) => r.agent_id === agent && (r.status === 'queued' || r.status === 'running')
        ),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return row ? { id: row.id } : null;
    },
    async claim(optimizationId) {
      const id = optimizationId;
      return (
        tables.update(
          'agent_optimizations',
          (r) => r.id === id && r.status === 'queued',
          (row) => ({ status: 'running', attempts: row.attempts + 1, updated_at: new Date() })
        ).length > 0
      );
    },
    async finish(optimizationId, outcome) {
      const id = optimizationId;
      tables.update('agent_optimizations', (r) => r.id === id, {
        ...outcomeColumns(outcome, new Date()),
        ...(outcome.status === 'succeeded' ? { result: toJson(outcome.result) } : {}),
      });
    },
    async markApplied(ownerSubject, optimizationId, draftId) {
      const id = optimizationId;
      tables.update(
        'agent_optimizations',
        (r) => r.owner_subject === ownerSubject && r.id === id,
        (row) => ({
          result: toJson(jsonbConcat(row.result, { draftId })),
          applied_at: new Date(),
          updated_at: new Date(),
        })
      );
    },
    async delete(optimizationId) {
      const id = optimizationId;
      tables.delete('agent_optimizations', (r) => r.id === id);
    },
    async ownerOf(optimizationId) {
      const id = optimizationId;
      const row = tables.first('agent_optimizations', (r) => r.id === id);
      return row ? { ownerSubject: row.owner_subject, agentId: row.agent_id } : null;
    },
    async failStuck(updatedBefore, error) {
      const now = new Date();
      return tables.update(
        'agent_optimizations',
        (r) => r.status === 'running' && r.updated_at.getTime() < updatedBefore.getTime(),
        { status: 'failed', error, finished_at: now, updated_at: now }
      ).length;
    },
    async pruneBefore(before, limit) {
      const doomed = new Set(
        page(
          orderBy(
            tables.select('agent_optimizations', (r) => r.created_at.getTime() < before.getTime()),
            [(r) => r.created_at],
            [(r) => r.id]
          ),
          limit
        ).map((r) => r.id)
      );
      return tables.delete('agent_optimizations', (r) => doomed.has(r.id)).length;
    },
  };
}
