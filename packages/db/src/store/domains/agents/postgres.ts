import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { agentFromRow, definitionColumns, escapeLike, isNameTaken, triggerFromRow } from './record';
import type { AgentAdminRecord, AgentStore, AgentTriggerRecord } from './types';

const active = sql<Date>`NOW()`;

export function postgresAgents(db: () => Kysely<DB>): AgentStore {
  async function triggersOf(agentIds: string[]): Promise<Map<string, AgentTriggerRecord[]>> {
    const byAgent = new Map<string, AgentTriggerRecord[]>();
    if (agentIds.length === 0) return byAgent;
    const rows = await db()
      .selectFrom('agent_triggers')
      .selectAll()
      .where('agent_id', 'in', agentIds)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    for (const row of rows) {
      const list = byAgent.get(row.agent_id) ?? [];
      list.push(triggerFromRow(row));
      byAgent.set(row.agent_id, list);
    }
    return byAgent;
  }

  function adminQuery() {
    return db()
      .selectFrom('agents as a')
      .leftJoin('identities as i', (join) => join.onRef('i.subject', '=', 'a.owner_subject'))
      .select((eb) => [
        'a.id',
        'a.name',
        'a.owner_subject',
        'a.enabled',
        'a.description',
        'a.description_status',
        'i.email',
        eb
          .selectFrom('agent_runs as r')
          .select((inner) => inner.fn.max('r.created_at').as('last'))
          .whereRef('r.agent_id', '=', 'a.id')
          .as('last_run_at'),
      ]);
  }

  function adminRecord(row: {
    id: string;
    name: string;
    owner_subject: string;
    enabled: boolean;
    description: string | null;
    description_status: string;
    email: string | null;
    last_run_at: Date | null;
  }): AgentAdminRecord {
    return {
      id: row.id,
      name: row.name,
      ownerSubject: row.owner_subject,
      ownerEmail: row.email,
      enabled: row.enabled,
      description: row.description,
      descriptionStatus: row.description_status,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    };
  }

  return {
    async list(ownerSubject) {
      const rows = await db()
        .selectFrom('agents')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .execute();
      const triggers = await triggersOf(rows.map((row) => row.id));
      return rows.map((row) => agentFromRow(row, triggers.get(row.id) ?? []));
    },
    async find(agentId, options = {}) {
      let query = db().selectFrom('agents').selectAll().where('id', '=', agentId);
      if (options.ownerSubject !== undefined) {
        query = query.where('owner_subject', '=', options.ownerSubject);
      }
      const row = await query.executeTakeFirst();
      if (!row) return null;
      const triggers = await triggersOf([row.id]);
      return agentFromRow(row, triggers.get(row.id) ?? []);
    },
    async listNames(ownerSubject) {
      return db()
        .selectFrom('agents')
        .select(['id', 'name'])
        .where('owner_subject', '=', ownerSubject)
        .orderBy('name')
        .orderBy('id')
        .execute();
    },
    async namesLike(prefix) {
      const rows = await db()
        .selectFrom('agents')
        .select('name')
        .where('name', 'like', `${prefix}%`)
        .orderBy('name')
        .execute();
      return rows.map((row) => row.name);
    },
    async create(agent) {
      try {
        await db()
          .insertInto('agents')
          .values({
            id: agent.id,
            owner_subject: agent.ownerSubject,
            ...definitionColumns(agent),
            description_status: 'stale',
          })
          .execute();
        return 'CREATED';
      } catch (error) {
        if (isNameTaken(error)) return 'NAME_TAKEN';
        throw error;
      }
    },
    async update(ownerSubject, agentId, values, { markDescriptionStale }) {
      try {
        const updated = await db()
          .updateTable('agents')
          .set({
            ...definitionColumns(values),
            steps_version: sql`steps_version + 1`,
            ...(markDescriptionStale ? { description_status: 'stale' } : {}),
            updated_at: sql`NOW()`,
          })
          .where('owner_subject', '=', ownerSubject)
          .where('id', '=', agentId)
          .executeTakeFirst();
        return Number(updated.numUpdatedRows ?? 0) === 0 ? 'NOT_FOUND' : 'UPDATED';
      } catch (error) {
        if (isNameTaken(error)) return 'NAME_TAKEN';
        throw error;
      }
    },
    async delete(ownerSubject, agentId) {
      const result = await db()
        .deleteFrom('agents')
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', agentId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
    async saveDescription(agentId, outcome) {
      await db()
        .updateTable('agents')
        .set(
          outcome.status === 'ok'
            ? {
                description: outcome.description,
                review_notes: JSON.stringify(outcome.reviewNotes),
                description_status: 'ok',
                updated_at: sql`NOW()`,
              }
            : { description_status: 'failed', updated_at: sql`NOW()` }
        )
        .where('id', '=', agentId)
        .execute();
    },
    async markDescriptionStale(agentId) {
      await db()
        .updateTable('agents')
        .set({ description_status: 'stale', updated_at: sql`NOW()` })
        .where('id', '=', agentId)
        .execute();
    },
    async listTriggers(agentId) {
      return (await triggersOf([agentId])).get(agentId) ?? [];
    },
    async applyTriggerChanges(agentId, changes) {
      await db()
        .transaction()
        .execute(async (trx) => {
          for (const change of changes.update) {
            await trx
              .updateTable('agent_triggers')
              .set({
                event_source: change.eventSource,
                event_type: change.eventType,
                config: change.config,
                enabled: change.enabled,
                next_run_at: change.nextRunAt,
                updated_at: sql`NOW()`,
              })
              .where('id', '=', change.id)
              .where('agent_id', '=', agentId)
              .execute();
          }
          for (const change of changes.insert) {
            await trx
              .insertInto('agent_triggers')
              .values({
                id: change.id,
                agent_id: agentId,
                kind: change.kind,
                event_source: change.eventSource,
                event_type: change.eventType,
                config: change.config,
                enabled: change.enabled,
                next_run_at: change.nextRunAt,
              })
              .execute();
          }
          if (changes.remove.length > 0) {
            await trx
              .deleteFrom('agent_triggers')
              .where('agent_id', '=', agentId)
              .where('id', 'in', changes.remove)
              .execute();
          }
        });
    },

    async findActiveGrant(agentId, granteeSubject) {
      const row = await db()
        .selectFrom('agent_access_grants')
        .select(['id', 'owner_subject', 'expires_at'])
        .where('agent_id', '=', agentId)
        .where('grantee_subject', '=', granteeSubject)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', active)]))
        .executeTakeFirst();
      return row
        ? { id: row.id, ownerSubject: row.owner_subject, expiresAt: row.expires_at }
        : null;
    },
    async upsertGrant(grant) {
      await db()
        .insertInto('agent_access_grants')
        .values({
          id: grant.id,
          agent_id: grant.agentId,
          owner_subject: grant.ownerSubject,
          grantee_subject: grant.granteeSubject,
          expires_at: grant.expiresAt,
        })
        .onConflict((oc) =>
          oc.columns(['agent_id', 'grantee_subject']).doUpdateSet({ expires_at: grant.expiresAt })
        )
        .execute();
    },
    async listGrants(agentId) {
      const rows = await db()
        .selectFrom('agent_access_grants')
        .leftJoin('identities', (join) =>
          join.onRef('identities.subject', '=', 'agent_access_grants.grantee_subject')
        )
        .select([
          'agent_access_grants.id as id',
          'agent_access_grants.grantee_subject as grantee_subject',
          'agent_access_grants.expires_at as expires_at',
          'agent_access_grants.created_at as created_at',
          'identities.display_name as display_name',
          'identities.email as email',
        ])
        .where('agent_access_grants.agent_id', '=', agentId)
        .orderBy('agent_access_grants.created_at', 'asc')
        .orderBy('agent_access_grants.id')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        granteeSubject: row.grantee_subject,
        granteeName: row.display_name,
        granteeEmail: row.email,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      }));
    },
    async revokeGrant(ownerSubject, agentId, grantId) {
      const row = await db()
        .deleteFrom('agent_access_grants')
        .where('agent_id', '=', agentId)
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', grantId)
        .returning(['grantee_subject'])
        .executeTakeFirst();
      return row ? { granteeSubject: row.grantee_subject } : null;
    },
    async listSharedWith(granteeSubject) {
      const rows = await db()
        .selectFrom('agent_access_grants')
        .leftJoin('identities', (join) =>
          join.onRef('identities.subject', '=', 'agent_access_grants.owner_subject')
        )
        .select([
          'agent_access_grants.agent_id as agent_id',
          'agent_access_grants.owner_subject as owner_subject',
          'agent_access_grants.expires_at as expires_at',
          'identities.display_name as owner_name',
          'identities.email as owner_email',
        ])
        .where('agent_access_grants.grantee_subject', '=', granteeSubject)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', active)]))
        .orderBy('agent_access_grants.created_at', 'desc')
        .orderBy('agent_access_grants.id')
        .execute();
      return rows.map((row) => ({
        agentId: row.agent_id,
        ownerSubject: row.owner_subject,
        ownerName: row.owner_name,
        ownerEmail: row.owner_email,
        expiresAt: row.expires_at,
      }));
    },
    async countActiveGrants(agentId) {
      const row = await db()
        .selectFrom('agent_access_grants')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('agent_id', '=', agentId)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', active)]))
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async listForAdmin({ ownerSubject }) {
      let query = adminQuery();
      if (ownerSubject !== null) query = query.where('a.owner_subject', '=', ownerSubject);
      const rows = await query.orderBy('a.name').orderBy('a.id').execute();
      return rows.map(adminRecord);
    },
    async findForAdmin(agentId) {
      const row = await adminQuery().where('a.id', '=', agentId).executeTakeFirst();
      return row ? adminRecord(row) : null;
    },

    async listNoteChunks(agentId, { provider, scope }) {
      const rows = await db()
        .selectFrom('knowledge_chunks')
        .select(['ref_id', 'metadata', 'content', 'keywords', 'source_at'])
        .where('provider', '=', provider)
        .where(sql<boolean>`metadata ->> 'agentId' = ${agentId}`)
        .where(sql<boolean>`metadata ->> 'scope' = ${scope}`)
        .orderBy('ref_id')
        .execute();
      return rows.map((row) => ({
        refId: row.ref_id,
        metadata: row.metadata,
        content: row.content,
        keywords: row.keywords,
        sourceAt: row.source_at,
      }));
    },
    async noteExists(agentId, refId, { provider, scope }) {
      const row = await db()
        .selectFrom('knowledge_chunks')
        .select(['ref_id'])
        .where('provider', '=', provider)
        .where(sql<boolean>`metadata ->> 'agentId' = ${agentId}`)
        .where(sql<boolean>`metadata ->> 'scope' = ${scope}`)
        .where((eb) =>
          eb.or([eb('ref_id', '=', refId), eb('ref_id', 'like', `${escapeLike(refId)}#%`)])
        )
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
    async copyNoteChunks({ provider, baseRef, newBase, targetAgentId }) {
      const result = await sql`
        INSERT INTO knowledge_chunks
          (id, provider, ref_id, metadata, content, embedding,
           keywords, search_text, source_at)
        SELECT gen_random_uuid(), provider,
               replace(ref_id, ${baseRef}, ${newBase}),
               jsonb_set(metadata, '{agentId}', to_jsonb(${targetAgentId}::text)),
               content, embedding, keywords, search_text, source_at
        FROM knowledge_chunks
        WHERE provider = ${provider}
          AND (ref_id = ${baseRef} OR ref_id LIKE ${baseRef} || '#%')
      `.execute(db());
      return Number(result.numAffectedRows ?? 0);
    },

    async memorySlice(agentId, maxEntries) {
      const rows = await db()
        .selectFrom('agent_memories')
        .select(['id', 'kind', 'content', 'created_at', 'updated_at'])
        .where('agent_id', '=', agentId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(maxEntries + 1)
        .execute();
      let summary = rows.find((row) => row.kind === 'summary') ?? null;
      // The summary sorts by its last-compaction time and may fall outside
      // the newest-N window once entries pile up — fetch it explicitly then.
      if (summary === null) {
        summary =
          (await db()
            .selectFrom('agent_memories')
            .select(['id', 'kind', 'content', 'created_at', 'updated_at'])
            .where('agent_id', '=', agentId)
            .where('kind', '=', 'summary')
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .executeTakeFirst()) ?? null;
      }
      const owner = await db()
        .selectFrom('agents')
        .select('owner_subject')
        .where('id', '=', agentId)
        .executeTakeFirst();
      return {
        ownerSubject: owner?.owner_subject ?? null,
        summary: summary ? { content: summary.content, updatedAt: summary.updated_at } : null,
        entries: rows
          .filter((row) => row.kind === 'entry')
          .slice(0, maxEntries)
          .map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at })),
      };
    },
    async clearMemory(agentId) {
      const deleted = await db()
        .deleteFrom('agent_memories')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return Number(deleted.numDeletedRows ?? 0);
    },
  };
}
