import { like, orderBy, page } from '../../memory/order';
import { MemoryStoreError, type MemoryTables, type Row } from '../../memory/tables';
import { jsonField } from './json';
import { agentFromRow, definitionColumns, escapeLike, isNameTaken, triggerFromRow } from './record';
import { memoryAgentSweeps } from './sweep-memory';
import type { AgentAdminRecord, AgentStore } from './types';

/** `expires_at IS NULL OR expires_at > NOW()`. */
function unexpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt.getTime() > now.getTime();
}

export function memoryAgents(tables: MemoryTables): AgentStore {
  const uuid = (value: string) => tables.param('agents', 'id', value);

  function triggersOf(agentId: string) {
    return orderBy(
      tables.select('agent_triggers', (r) => r.agent_id === agentId),
      [(r) => r.created_at],
      [(r) => r.id]
    ).map(triggerFromRow);
  }

  function identity(subject: string) {
    return tables.first('identities', (r) => r.subject === subject);
  }

  function adminRecord(row: Row<'agents'>): AgentAdminRecord {
    const runs = tables.select('agent_runs', (r) => r.agent_id === row.id);
    const last = runs.reduce<Date | null>(
      (latest, run) =>
        latest === null || run.created_at.getTime() > latest.getTime() ? run.created_at : latest,
      null
    );
    return {
      id: row.id,
      name: row.name,
      ownerSubject: row.owner_subject,
      ownerEmail: identity(row.owner_subject)?.email ?? null,
      enabled: row.enabled,
      description: row.description,
      descriptionStatus: row.description_status,
      lastRunAt: last,
    };
  }

  function noteChunks(agentId: string, provider: string, scope: string) {
    return tables.select(
      'knowledge_chunks',
      (r) =>
        r.provider === provider &&
        jsonField(r.metadata, 'agentId') === agentId &&
        jsonField(r.metadata, 'scope') === scope
    );
  }

  return {
    ...memoryAgentSweeps(tables),
    async list(ownerSubject) {
      const rows = orderBy(
        tables.select('agents', (r) => r.owner_subject === ownerSubject),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return rows.map((row) => agentFromRow(row, triggersOf(row.id)));
    },
    async find(agentId, options = {}) {
      const id = uuid(agentId);
      const row = tables.first(
        'agents',
        (r) =>
          r.id === id &&
          (options.ownerSubject === undefined || r.owner_subject === options.ownerSubject)
      );
      return row ? agentFromRow(row, triggersOf(row.id)) : null;
    },
    async listNames(ownerSubject) {
      return orderBy(
        tables.select('agents', (r) => r.owner_subject === ownerSubject),
        [(r) => r.name],
        [(r) => r.id]
      ).map((row) => ({ id: row.id, name: row.name }));
    },
    async listChainedAfter(callerAgentId, ownerSubject) {
      const chained = tables
        .select(
          'agent_triggers',
          (t) =>
            t.kind === 'agent' &&
            t.enabled &&
            jsonField(t.config, 'callerAgentId') === callerAgentId
        )
        .flatMap((t) => {
          const owned = tables.first(
            'agents',
            (a) => a.id === t.agent_id && a.owner_subject === ownerSubject
          );
          return owned ? [{ id: owned.id, name: owned.name, triggerId: t.id }] : [];
        });
      return orderBy(chained, [(r) => r.name], [(r) => r.id], [(r) => r.triggerId]).map(
        ({ id, name }) => ({ id, name })
      );
    },
    async namesLike(prefix) {
      return orderBy(
        tables.select('agents', (r) => like(r.name, `${prefix}%`, true)),
        [(r) => r.name]
      ).map((row) => row.name);
    },
    async create(agent) {
      try {
        tables.insert('agents', {
          id: agent.id,
          owner_subject: agent.ownerSubject,
          ...definitionColumns(agent),
          description_status: 'stale',
        });
        return 'CREATED';
      } catch (error) {
        if (isNameTaken(error)) return 'NAME_TAKEN';
        throw error;
      }
    },
    async update(ownerSubject, agentId, values, { markDescriptionStale }) {
      const id = uuid(agentId);
      try {
        const updated = tables.update(
          'agents',
          (r) => r.owner_subject === ownerSubject && r.id === id,
          (row) => ({
            ...definitionColumns(values),
            steps_version: row.steps_version + 1,
            ...(markDescriptionStale ? { description_status: 'stale' } : {}),
            updated_at: new Date(),
          })
        );
        return updated.length === 0 ? 'NOT_FOUND' : 'UPDATED';
      } catch (error) {
        if (isNameTaken(error)) return 'NAME_TAKEN';
        throw error;
      }
    },
    async delete(ownerSubject, agentId) {
      const id = uuid(agentId);
      return (
        tables.delete('agents', (r) => r.owner_subject === ownerSubject && r.id === id).length > 0
      );
    },
    async saveDescription(agentId, outcome) {
      const id = uuid(agentId);
      tables.update(
        'agents',
        (r) => r.id === id,
        outcome.status === 'ok'
          ? {
              description: outcome.description,
              review_notes: JSON.stringify(outcome.reviewNotes),
              description_status: 'ok',
              updated_at: new Date(),
            }
          : { description_status: 'failed', updated_at: new Date() }
      );
    },
    async markDescriptionStale(agentId) {
      const id = uuid(agentId);
      tables.update('agents', (r) => r.id === id, {
        description_status: 'stale',
        updated_at: new Date(),
      });
    },
    async setEnabled(agentId, enabled) {
      const id = uuid(agentId);
      const [row] = tables.update('agents', (r) => r.id === id, {
        enabled,
        updated_at: new Date(),
      });
      return row ? { name: row.name } : null;
    },
    async listTriggers(agentId) {
      return triggersOf(String(uuid(agentId)));
    },
    async markTriggerFired(triggerId) {
      const id = tables.param('agent_triggers', 'id', triggerId);
      const now = new Date();
      tables.update('agent_triggers', (r) => r.id === id, {
        last_fired_at: now,
        last_error: null,
        updated_at: now,
      });
    },
    async applyTriggerChanges(agentId, changes) {
      const id = String(uuid(agentId));
      const param = (value: string) => tables.param('agent_triggers', 'id', value);
      // All or none: every refusal (a malformed id, a missing agent, a
      // duplicate id) is found before anything changes.
      const updates = changes.update.map((change) => ({ ...change, id: param(change.id) }));
      const removals = new Set(changes.remove.map(param));
      if (changes.insert.length > 0 && !tables.first('agents', (r) => r.id === id)) {
        throw new MemoryStoreError(
          '23503',
          'insert or update on table "agent_triggers" violates foreign key to "agents"',
          'agent_triggers'
        );
      }
      const inserted = changes.insert.map((change) => param(change.id));
      for (const insertId of inserted) {
        if (
          tables.first('agent_triggers', (r) => r.id === insertId) ||
          inserted.filter((other) => other === insertId).length > 1
        ) {
          throw new MemoryStoreError(
            '23505',
            'duplicate key value violates unique constraint on agent_triggers (id)',
            'agent_triggers',
            'agent_triggers_id'
          );
        }
      }
      for (const change of updates) {
        tables.update('agent_triggers', (r) => r.id === change.id && r.agent_id === id, {
          event_source: change.eventSource,
          event_type: change.eventType,
          config: change.config,
          enabled: change.enabled,
          next_run_at: change.nextRunAt,
          updated_at: new Date(),
        });
      }
      for (const change of changes.insert) {
        tables.insert('agent_triggers', {
          id: change.id,
          agent_id: id,
          kind: change.kind,
          event_source: change.eventSource,
          event_type: change.eventType,
          config: change.config,
          enabled: change.enabled,
          next_run_at: change.nextRunAt,
        });
      }
      if (removals.size > 0) {
        tables.delete('agent_triggers', (r) => r.agent_id === id && removals.has(r.id));
      }
    },

    async findActiveGrant(agentId, granteeSubject) {
      const id = tables.param('agent_access_grants', 'agent_id', agentId);
      const now = new Date();
      const row = tables.first(
        'agent_access_grants',
        (r) =>
          r.agent_id === id && r.grantee_subject === granteeSubject && unexpired(r.expires_at, now)
      );
      return row
        ? { id: row.id, ownerSubject: row.owner_subject, expiresAt: row.expires_at }
        : null;
    },
    async upsertGrant(grant) {
      tables.upsert(
        'agent_access_grants',
        {
          id: grant.id,
          agent_id: grant.agentId,
          owner_subject: grant.ownerSubject,
          grantee_subject: grant.granteeSubject,
          expires_at: grant.expiresAt,
        },
        ['agent_id', 'grantee_subject'],
        { expires_at: grant.expiresAt }
      );
    },
    async listGrants(agentId) {
      const id = tables.param('agent_access_grants', 'agent_id', agentId);
      return orderBy(
        tables.select('agent_access_grants', (r) => r.agent_id === id),
        [(r) => r.created_at],
        [(r) => r.id]
      ).map((row) => {
        const who = identity(row.grantee_subject);
        return {
          id: row.id,
          granteeSubject: row.grantee_subject,
          granteeName: who?.display_name ?? null,
          granteeEmail: who?.email ?? null,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        };
      });
    },
    async revokeGrant(ownerSubject, agentId, grantId) {
      const agent = tables.param('agent_access_grants', 'agent_id', agentId);
      const id = tables.param('agent_access_grants', 'id', grantId);
      const [row] = tables.delete(
        'agent_access_grants',
        (r) => r.agent_id === agent && r.owner_subject === ownerSubject && r.id === id
      );
      return row ? { granteeSubject: row.grantee_subject } : null;
    },
    async listSharedWith(granteeSubject) {
      const now = new Date();
      return orderBy(
        tables.select(
          'agent_access_grants',
          (r) => r.grantee_subject === granteeSubject && unexpired(r.expires_at, now)
        ),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      ).map((row) => {
        const owner = identity(row.owner_subject);
        return {
          agentId: row.agent_id,
          ownerSubject: row.owner_subject,
          ownerName: owner?.display_name ?? null,
          ownerEmail: owner?.email ?? null,
          expiresAt: row.expires_at,
        };
      });
    },
    async countActiveGrants(agentId) {
      const id = tables.param('agent_access_grants', 'agent_id', agentId);
      const now = new Date();
      return tables.select(
        'agent_access_grants',
        (r) => r.agent_id === id && unexpired(r.expires_at, now)
      ).length;
    },

    async listForAdmin({ ownerSubject }) {
      return orderBy(
        tables.select('agents', (r) => ownerSubject === null || r.owner_subject === ownerSubject),
        [(r) => r.name],
        [(r) => r.id]
      ).map(adminRecord);
    },
    async findForAdmin(agentId) {
      const id = uuid(agentId);
      const row = tables.first('agents', (r) => r.id === id);
      return row ? adminRecord(row) : null;
    },

    async listNoteChunks(agentId, { provider, scope }) {
      return orderBy(noteChunks(agentId, provider, scope), [(r) => r.ref_id]).map((row) => ({
        refId: row.ref_id,
        metadata: row.metadata,
        content: row.content,
        keywords: row.keywords,
        sourceAt: row.source_at,
      }));
    },
    async noteExists(agentId, refId, { provider, scope }) {
      const pattern = `${escapeLike(refId)}#%`;
      return noteChunks(agentId, provider, scope).some(
        (r) => r.ref_id === refId || like(r.ref_id, pattern, true)
      );
    },
    async copyNoteChunks({ provider, baseRef, newBase, targetAgentId }) {
      const pattern = `${escapeLike(baseRef)}#%`;
      // Postgres concatenates the base into the pattern unescaped: a base
      // carrying % or _ matches wider there. Note refs never do (an email
      // and a uuid), which is all this has to agree on.
      const sources = orderBy(
        tables.select(
          'knowledge_chunks',
          (r) => r.provider === provider && (r.ref_id === baseRef || like(r.ref_id, pattern, true))
        ),
        [(r) => r.ref_id]
      );
      const rows = sources.map((row) => {
        const metadata: Record<string, unknown> =
          typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
            ? { ...row.metadata, agentId: targetAgentId }
            : {};
        return {
          provider: row.provider,
          ref_id: row.ref_id.split(baseRef).join(newBase),
          metadata: JSON.stringify(metadata),
          content: row.content,
          embedding: row.embedding,
          keywords: row.keywords,
          search_text: row.search_text,
          source_at: row.source_at,
          id: globalThis.crypto.randomUUID(),
        };
      });
      return tables.insertMany('knowledge_chunks', rows).length;
    },

    async memorySlice(agentId, maxEntries) {
      const id = tables.param('agent_memories', 'agent_id', agentId);
      const all = orderBy(
        tables.select('agent_memories', (r) => r.agent_id === id),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      const window = all.slice(0, maxEntries + 1);
      const summary =
        window.find((row) => row.kind === 'summary') ??
        all.find((row) => row.kind === 'summary') ??
        null;
      const owner = tables.first('agents', (r) => r.id === id);
      return {
        ownerSubject: owner?.owner_subject ?? null,
        summary: summary ? { content: summary.content, updatedAt: summary.updated_at } : null,
        entries: window
          .filter((row) => row.kind === 'entry')
          .slice(0, maxEntries)
          .map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at })),
      };
    },
    async clearMemory(agentId) {
      const id = tables.param('agent_memories', 'agent_id', agentId);
      return tables.delete('agent_memories', (r) => r.agent_id === id).length;
    },
    async addMemoryEntry(entry) {
      tables.insert('agent_memories', {
        id: entry.id,
        agent_id: entry.agentId,
        kind: 'entry',
        content: entry.content,
        run_id: entry.runId,
      });
    },
    async saveMemorySummary(summary) {
      const id = tables.param('agent_memories', 'agent_id', summary.agentId);
      const changed = tables.update(
        'agent_memories',
        (r) => r.agent_id === id && r.kind === 'summary',
        { content: summary.content, updated_at: new Date() }
      );
      if (changed.length > 0) return;
      tables.insert('agent_memories', {
        id: summary.id,
        agent_id: summary.agentId,
        kind: 'summary',
        content: summary.content,
      });
    },
    async countMemory(agentId) {
      const id = tables.param('agent_memories', 'agent_id', agentId);
      const rows = tables.select('agent_memories', (r) => r.agent_id === id);
      return {
        entries: rows.filter((r) => r.kind !== 'summary').length,
        hasSummary: rows.some((r) => r.kind === 'summary'),
      };
    },
    async deleteMemorySummary(agentId) {
      const id = tables.param('agent_memories', 'agent_id', agentId);
      return tables.delete('agent_memories', (r) => r.agent_id === id && r.kind === 'summary')
        .length;
    },
    async deleteMemoryEntries(agentId, ids) {
      if (ids.length === 0) return [];
      const id = tables.param('agent_memories', 'agent_id', agentId);
      const wanted = new Set(ids.map((entry) => tables.param('agent_memories', 'id', entry)));
      return tables
        .delete(
          'agent_memories',
          (r) => r.agent_id === id && r.kind === 'entry' && wanted.has(r.id)
        )
        .map((row) => row.id)
        .sort();
    },
    async recentNoteChunks(agentId, { provider, scope, limit }) {
      return page(
        orderBy(
          noteChunks(agentId, provider, scope),
          [(r) => r.source_at, 'desc'],
          [(r) => r.ref_id]
        ),
        limit
      ).map((row) => ({
        refId: row.ref_id,
        metadata: row.metadata,
        content: row.content,
        keywords: row.keywords,
        sourceAt: row.source_at,
      }));
    },
  };
}
