import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { LegacyEnvelopeStore } from './types';

export function postgresLegacyEnvelopes(db: () => Kysely<DB>): LegacyEnvelopeStore {
  return {
    async chatsPage(after, limit) {
      let query = db()
        .selectFrom('chats')
        .select(['id', 'owner_subject'])
        .orderBy('id', 'asc')
        .limit(limit);
      if (after) query = query.where('id', '>', after);
      const rows = await query.execute();
      return rows.map((row) => ({ id: row.id, ownerSubject: row.owner_subject }));
    },
    async projects() {
      const rows = await db()
        .selectFrom('chat_projects')
        .select(['id', 'owner_subject', 'instructions'])
        .orderBy('id', 'asc')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        ownerSubject: row.owner_subject,
        instructions: row.instructions,
      }));
    },
    async chatRows(chatId, notLike) {
      const messages = await db()
        .selectFrom('chat_messages')
        .select(['id', 'content'])
        .where('chat_id', '=', chatId)
        .where('content', 'not like', notLike)
        .orderBy('id')
        .execute();
      const summaries = await db()
        .selectFrom('chat_summaries')
        .select(['id', 'content'])
        .where('chat_id', '=', chatId)
        .where('content', 'not like', notLike)
        .orderBy('id')
        .execute();
      const subagentRuns = await db()
        .selectFrom('chat_subagent_runs')
        .select(['id', 'task', 'instructions', 'transcript', 'report'])
        .where('chat_id', '=', chatId)
        .where('task', 'not like', notLike)
        .orderBy('id')
        .execute();
      return { messages, summaries, subagentRuns };
    },
    async attachments(keyKind, keyRef, notLike) {
      const rows = await db()
        .selectFrom('artifacts')
        .select(['id', 'extracted_text'])
        .where('extracted_text', 'is not', null)
        .where('extracted_text', 'not like', notLike)
        .where('key_kind', '=', keyKind)
        .where('key_ref', '=', keyRef)
        .orderBy('id')
        .execute();
      return rows.map((row) => ({ id: row.id, extractedText: row.extracted_text ?? '' }));
    },
    async projectMemories(projectId, notLike) {
      return db()
        .selectFrom('chat_project_memories')
        .select(['id', 'content'])
        .where('project_id', '=', projectId)
        .where('content', 'not like', notLike)
        .orderBy('id')
        .execute();
    },
    async userMemories(notLike) {
      const rows = await db()
        .selectFrom('chat_user_memories')
        .select(['id', 'owner_subject', 'content'])
        .where('content', 'not like', notLike)
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        ownerSubject: row.owner_subject,
        content: row.content,
      }));
    },
    async credentials(table, notLike) {
      const rows = await db()
        .selectFrom(table)
        .select(['subject', 'encrypted_credentials'])
        .where('encrypted_credentials', 'not like', notLike)
        .orderBy('subject')
        .orderBy('encrypted_credentials')
        .execute();
      return rows.map((row) => ({
        subject: row.subject,
        encryptedCredentials: row.encrypted_credentials,
      }));
    },
    async providerGrants(notLike) {
      const rows = await db()
        .selectFrom('provider_grants')
        .select([
          'provider',
          'provider_account_id',
          'subject',
          'encrypted_access_token',
          'encrypted_refresh_token',
        ])
        .where('subject', 'is not', null)
        .where((eb) =>
          eb.or([
            eb('encrypted_access_token', 'not like', notLike),
            eb('encrypted_refresh_token', 'not like', notLike),
          ])
        )
        .orderBy('provider')
        .orderBy('provider_account_id')
        .execute();
      return rows.map((row) => ({
        provider: row.provider,
        accountId: row.provider_account_id,
        subject: row.subject ?? '',
        encryptedAccessToken: row.encrypted_access_token,
        encryptedRefreshToken: row.encrypted_refresh_token,
      }));
    },
    async reseal(write) {
      switch (write.table) {
        case 'chat_messages':
        case 'chat_summaries':
        case 'chat_project_memories':
        case 'chat_user_memories': {
          const result = await db()
            .updateTable(write.table)
            .set({ content: write.content })
            .where('id', '=', write.id)
            .executeTakeFirst();
          return Number(result.numUpdatedRows);
        }
        case 'chat_subagent_runs': {
          const set = {
            ...(write.task !== undefined ? { task: write.task } : {}),
            ...(write.instructions !== undefined ? { instructions: write.instructions } : {}),
            ...(write.transcript !== undefined ? { transcript: write.transcript } : {}),
            ...(write.report !== undefined ? { report: write.report } : {}),
          };
          if (Object.keys(set).length === 0) return 0;
          const result = await db()
            .updateTable('chat_subagent_runs')
            .set(set)
            .where('id', '=', write.id)
            .executeTakeFirst();
          return Number(result.numUpdatedRows);
        }
        case 'artifacts': {
          const result = await db()
            .updateTable('artifacts')
            .set({ extracted_text: write.extractedText })
            .where('id', '=', write.id)
            .executeTakeFirst();
          return Number(result.numUpdatedRows);
        }
        case 'chat_projects': {
          const result = await db()
            .updateTable('chat_projects')
            .set({ instructions: write.instructions })
            .where('id', '=', write.id)
            .executeTakeFirst();
          return Number(result.numUpdatedRows);
        }
        case 'provider_grants': {
          const set = {
            ...(write.encryptedAccessToken !== undefined
              ? { encrypted_access_token: write.encryptedAccessToken }
              : {}),
            ...(write.encryptedRefreshToken !== undefined
              ? { encrypted_refresh_token: write.encryptedRefreshToken }
              : {}),
          };
          if (Object.keys(set).length === 0) return 0;
          const result = await db()
            .updateTable('provider_grants')
            .set(set)
            .where('provider', '=', write.provider)
            .where('provider_account_id', '=', write.accountId)
            .executeTakeFirst();
          return Number(result.numUpdatedRows);
        }
        default: {
          const result = await db()
            .updateTable(write.table)
            .set({ encrypted_credentials: write.next })
            .where('subject', '=', write.subject)
            .where('encrypted_credentials', '=', write.stored)
            .executeTakeFirst();
          return Number(result.numUpdatedRows);
        }
      }
    },
  };
}
