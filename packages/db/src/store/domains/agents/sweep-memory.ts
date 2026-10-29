import { groupBy, like, orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { AgentSweepStore } from './sweep-types';

export function memoryAgentSweeps(tables: MemoryTables): AgentSweepStore {
  /** The agent's entries, newest first (ties by id, descending). */
  function entriesOf(agentId: string) {
    const agent = agentId;
    return orderBy(
      tables.select('agent_memories', (r) => r.agent_id === agent && r.kind === 'entry'),
      [(r) => r.created_at, 'desc'],
      [(r) => r.id, 'desc']
    );
  }

  /** Every agent's owner, by agent id (the inner join to agents). */
  const owners = () => new Map(tables.select('agents').map((a) => [a.id, a.owner_subject]));

  return {
    async memoryCompactionCandidates(threshold, limit) {
      const ownerOf = owners();
      const groups = groupBy(
        tables.select('agent_memories', (r) => r.kind === 'entry' && ownerOf.has(r.agent_id)),
        (r) => r.agent_id
      );
      const candidates = [...groups.entries()]
        .filter(([, rows]) => rows.length > threshold)
        .map(([agentId, rows]) => ({
          agentId,
          ownerSubject: ownerOf.get(agentId) ?? '',
          entries: rows.length,
        }));
      return page(orderBy(candidates, [(c) => c.entries, 'desc'], [(c) => c.agentId]), limit);
    },
    async memoryFoldSet(agentId, { keepRecent, limit }) {
      const entries = page(entriesOf(agentId), limit, keepRecent);
      if (entries.length === 0) return null;
      const agent = agentId;
      const summary = tables.first(
        'agent_memories',
        (r) => r.agent_id === agent && r.kind === 'summary'
      );
      const row = tables.first('agents', (r) => r.id === agent);
      if (!row) return null;
      return {
        entries: entries.map((e) => ({ id: e.id, content: e.content, createdAt: e.created_at })),
        summary: summary?.content ?? null,
        llmModelId: row.llm_model_id,
      };
    },
    async trimMemoryEntries(agentId, keep) {
      const over = new Set(page(entriesOf(agentId), undefined, keep).map((r) => r.id));
      if (over.size === 0) return 0;
      return tables.delete('agent_memories', (r) => over.has(r.id)).length;
    },
    async listPlaintextMemory({ afterId, sealedPrefix, limit }) {
      const after = afterId === null ? null : String(afterId);
      const ownerOf = owners();
      const rows = tables.select(
        'agent_memories',
        (r) =>
          ownerOf.has(r.agent_id) &&
          !like(r.content, `${sealedPrefix}%`, true) &&
          (after === null || r.id > after)
      );
      return page(orderBy(rows, [(r) => r.id]), limit).map((r) => ({
        id: r.id,
        content: r.content,
        ownerSubject: ownerOf.get(r.agent_id) ?? '',
      }));
    },
    async replaceMemoryContent(id, expected, content) {
      const key = id;
      return (
        tables.update('agent_memories', (r) => r.id === key && r.content === expected, {
          content,
        }).length > 0
      );
    },

    async listDueScheduleTriggers(now, limit) {
      const agents = new Map(tables.select('agents', (a) => a.enabled).map((a) => [a.id, a]));
      const due = tables.select(
        'agent_triggers',
        (t) =>
          t.kind === 'schedule' &&
          t.enabled &&
          agents.has(t.agent_id) &&
          t.next_run_at !== null &&
          t.next_run_at.getTime() <= now.getTime()
      );
      return page(orderBy(due, [(t) => t.next_run_at], [(t) => t.id]), limit).flatMap((t) => {
        const agent = agents.get(t.agent_id);
        if (!agent || t.next_run_at === null) return [];
        return [
          {
            triggerId: t.id,
            agentId: t.agent_id,
            config: t.config,
            nextRunAt: t.next_run_at,
            ownerSubject: agent.owner_subject,
            instructions: agent.instructions,
            tools: agent.tools,
            llmModelId: agent.llm_model_id,
          },
        ];
      });
    },
    async disableTrigger(triggerId, lastError) {
      const key = triggerId;
      tables.update('agent_triggers', (r) => r.id === key, {
        enabled: false,
        last_error: lastError,
        updated_at: new Date(),
      });
    },
    async advanceScheduleTrigger(triggerId, observed, next) {
      const key = triggerId;
      const now = new Date();
      return (
        tables.update(
          'agent_triggers',
          (r) =>
            r.id === key &&
            r.next_run_at !== null &&
            r.next_run_at.getTime() === observed.getTime(),
          { next_run_at: next, last_fired_at: now, updated_at: now }
        ).length > 0
      );
    },
    async setTriggerError(triggerId, lastError) {
      const key = triggerId;
      tables.update('agent_triggers', (r) => r.id === key, {
        last_error: lastError,
        updated_at: new Date(),
      });
    },
  };
}
