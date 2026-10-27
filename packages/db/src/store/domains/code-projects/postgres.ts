import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, SandboxSizeRequests } from '../../../db.types';
import type { CodeProjectStore, SizeRequestRecord } from './types';

export function sizeRequestFromRow(row: Selectable<SandboxSizeRequests>): SizeRequestRecord {
  return {
    id: row.id,
    subject: row.subject,
    requestedBy: row.requested_by,
    requestedBytes: Number(row.requested_bytes),
    reason: row.reason,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    decisionNote: row.decision_note,
    createdAt: new Date(row.created_at),
  };
}

export function postgresCodeProjects(db: () => Kysely<DB>): CodeProjectStore {
  return {
    async workspaceBranches(workspaceIds) {
      if (workspaceIds.length === 0) return [];
      const rows = await db()
        .selectFrom('sandbox_workspaces')
        .select(['id', 'branch'])
        .where('id', 'in', workspaceIds)
        .where('status', '=', 'ready')
        .orderBy('id')
        .execute();
      return rows.filter((row) => row.branch);
    },
    async usageByChat(projectId) {
      const rows = await db()
        .selectFrom('chat_turns')
        .innerJoin('chats', 'chats.id', 'chat_turns.chat_id')
        .select(({ fn }) => [
          'chat_turns.chat_id as chat_id',
          fn.sum<string>('chat_turns.input_tokens').as('input_tokens'),
          fn.sum<string>('chat_turns.output_tokens').as('output_tokens'),
        ])
        .where('chats.project_id', '=', projectId)
        .groupBy('chat_turns.chat_id')
        .orderBy('chat_turns.chat_id')
        .execute();
      return rows.map((row) => ({
        chatId: row.chat_id,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
      }));
    },
    async latestSizeRequest(subject) {
      const row = await db()
        .selectFrom('sandbox_size_requests')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      return row ? sizeRequestFromRow(row) : null;
    },
    async approvedSizes(subject) {
      const rows = await db()
        .selectFrom('sandbox_size_requests')
        .select('requested_bytes')
        .where('subject', '=', subject)
        .where('status', '=', 'approved')
        .execute();
      return rows.map((row) => Number(row.requested_bytes)).sort((a, b) => a - b);
    },
    async createSizeRequest(request) {
      const row = await db()
        .insertInto('sandbox_size_requests')
        .values({
          subject: request.subject,
          requested_by: request.requestedBy,
          requested_bytes: request.requestedBytes,
          reason: request.reason,
        })
        .onConflict((oc) => oc.columns(['subject']).where('status', '=', 'pending').doNothing())
        .returningAll()
        .executeTakeFirst();
      return row ? sizeRequestFromRow(row) : null;
    },
    async listSizeRequests(projectPrefix, limit) {
      const rows = await db()
        .selectFrom('sandbox_size_requests as r')
        .leftJoin('chat_projects as p', (join) =>
          join.on(sql<boolean>`r.subject = ${projectPrefix} || p.id::text`)
        )
        .selectAll('r')
        .select('p.name as project_name')
        .orderBy((eb) => eb.case().when('r.status', '=', 'pending').then(0).else(1).end())
        .orderBy('r.created_at', 'desc')
        .orderBy('r.id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({ ...sizeRequestFromRow(row), projectName: row.project_name }));
    },
    async decideSizeRequest(decision) {
      const row = await db()
        .updateTable('sandbox_size_requests')
        .set({
          status: decision.status,
          decided_by: decision.decidedBy,
          decided_at: new Date().toISOString(),
          decision_note: decision.note,
          ...(decision.status === 'approved' && decision.approvedBytes !== undefined
            ? { requested_bytes: decision.approvedBytes }
            : {}),
        })
        .where('id', '=', decision.id)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      return row ? sizeRequestFromRow(row) : null;
    },
    async providerGrantScopes(subject, provider) {
      const row = await db()
        .selectFrom('provider_grants')
        .select(['requested_scopes', 'granted_scopes'])
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .orderBy('updated_at', 'desc')
        .orderBy('provider_account_id')
        .limit(1)
        .executeTakeFirst();
      return row
        ? { requestedScopes: row.requested_scopes, grantedScopes: row.granted_scopes }
        : null;
    },
  };
}
