import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { draftFromRow, outcomeColumns } from './record';
import type { AgentDraftStore } from './types';

export function memoryAgentDrafts(tables: MemoryTables): AgentDraftStore {
  const idOf = (value: string) => tables.param('agent_drafts', 'id', value);

  return {
    async create({ ownerSubject, agentId, request }) {
      return tables.insert('agent_drafts', {
        owner_subject: ownerSubject,
        agent_id: agentId,
        status: 'queued',
        request: JSON.stringify(request),
      }).id;
    },
    async find(ownerSubject, draftId) {
      const id = idOf(draftId);
      const row = tables.first(
        'agent_drafts',
        (r) => r.owner_subject === ownerSubject && r.id === id
      );
      return row ? draftFromRow(row) : null;
    },
    async latestReady(ownerSubject, agentId) {
      const agent = agentId === null ? null : tables.param('agent_drafts', 'agent_id', agentId);
      const [row] = orderBy(
        tables.select(
          'agent_drafts',
          (r) =>
            r.owner_subject === ownerSubject &&
            r.status === 'succeeded' &&
            r.consumed_at === null &&
            (agent === null ? r.agent_id === null : r.agent_id === agent)
        ),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return row ? draftFromRow(row) : null;
    },
    async consume(ownerSubject, draftId) {
      const id = idOf(draftId);
      const now = new Date();
      tables.update('agent_drafts', (r) => r.owner_subject === ownerSubject && r.id === id, {
        consumed_at: now,
        updated_at: now,
      });
    },
    async claim(draftId) {
      const id = idOf(draftId);
      return (
        tables.update(
          'agent_drafts',
          (r) => r.id === id && r.status === 'queued',
          (row) => ({ status: 'running', attempts: row.attempts + 1, updated_at: new Date() })
        ).length > 0
      );
    },
    async finish(draftId, outcome) {
      const id = idOf(draftId);
      tables.update('agent_drafts', (r) => r.id === id, outcomeColumns(outcome, new Date()));
    },
    async delete(draftId) {
      const id = idOf(draftId);
      tables.delete('agent_drafts', (r) => r.id === id);
    },
    async ownerOf(draftId) {
      const id = idOf(draftId);
      const row = tables.first('agent_drafts', (r) => r.id === id);
      return row ? { ownerSubject: row.owner_subject, agentId: row.agent_id } : null;
    },
    async failStuck(updatedBefore, error) {
      const now = new Date();
      return tables.update(
        'agent_drafts',
        (r) => r.status === 'running' && r.updated_at.getTime() < updatedBefore.getTime(),
        { status: 'failed', error, finished_at: now, updated_at: now }
      ).length;
    },
    async pruneBefore(before, limit) {
      const doomed = new Set(
        page(
          orderBy(
            tables.select('agent_drafts', (r) => r.created_at.getTime() < before.getTime()),
            [(r) => r.created_at],
            [(r) => r.id]
          ),
          limit
        ).map((r) => r.id)
      );
      return tables.delete('agent_drafts', (r) => doomed.has(r.id)).length;
    },
  };
}
