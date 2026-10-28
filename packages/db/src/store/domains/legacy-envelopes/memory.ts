import { compareAsc, like, orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { LegacyEnvelopeStore } from './types';

export function memoryLegacyEnvelopes(tables: MemoryTables): LegacyEnvelopeStore {
  /** `value NOT LIKE pattern`: false for a null, as SQL's NULL is not true. */
  const notLikeOf = (value: string | null, pattern: string) =>
    value !== null && !like(value, pattern, true);
  const byId = <T extends { id: string }>(rows: T[]) => orderBy(rows, [(r) => r.id]);

  return {
    async chatsPage(after, limit) {
      const from = after === null ? null : after;
      const rows = tables.select('chats', (r) => from === null || compareAsc(r.id, from) > 0);
      return page(byId(rows), limit).map((row) => ({
        id: row.id,
        ownerSubject: row.owner_subject,
      }));
    },
    async projects() {
      return byId(tables.select('chat_projects')).map((row) => ({
        id: row.id,
        ownerSubject: row.owner_subject,
        instructions: row.instructions,
      }));
    },
    async chatRows(chatId, notLike) {
      const chat = chatId;
      return {
        messages: byId(
          tables.select('chat_messages', (r) => r.chat_id === chat && notLikeOf(r.content, notLike))
        ).map((row) => ({ id: row.id, content: row.content })),
        summaries: byId(
          tables.select(
            'chat_summaries',
            (r) => r.chat_id === chat && notLikeOf(r.content, notLike)
          )
        ).map((row) => ({ id: row.id, content: row.content })),
        subagentRuns: byId(
          tables.select(
            'chat_subagent_runs',
            (r) => r.chat_id === chat && notLikeOf(r.task, notLike)
          )
        ).map((row) => ({
          id: row.id,
          task: row.task,
          instructions: row.instructions,
          transcript: row.transcript,
          report: row.report,
        })),
      };
    },
    async attachments(keyKind, keyRef, notLike) {
      const ref = keyRef;
      const rows = tables.select(
        'artifacts',
        (r) => r.key_kind === keyKind && r.key_ref === ref && notLikeOf(r.extracted_text, notLike)
      );
      return byId(rows).map((row) => ({ id: row.id, extractedText: row.extracted_text ?? '' }));
    },
    async projectMemories(projectId, notLike) {
      const project = projectId;
      return byId(
        tables.select(
          'chat_project_memories',
          (r) => r.project_id === project && notLikeOf(r.content, notLike)
        )
      ).map((row) => ({ id: row.id, content: row.content }));
    },
    async userMemories(notLike) {
      return byId(tables.select('chat_user_memories', (r) => notLikeOf(r.content, notLike))).map(
        (row) => ({ id: row.id, ownerSubject: row.owner_subject, content: row.content })
      );
    },
    async credentials(table, notLike) {
      const rows = tables
        .selectWhere(table, (r) => {
          const stored = r.encrypted_credentials;
          return typeof stored === 'string' && notLikeOf(stored, notLike);
        })
        .map((row) => ({
          subject: String(row.subject),
          encryptedCredentials: String(row.encrypted_credentials),
        }));
      return orderBy(rows, [(r) => r.subject], [(r) => r.encryptedCredentials]);
    },
    async providerGrants(notLike) {
      const rows = tables.select(
        'provider_grants',
        (r) =>
          r.subject !== null &&
          (notLikeOf(r.encrypted_access_token, notLike) ||
            notLikeOf(r.encrypted_refresh_token, notLike))
      );
      return orderBy(rows, [(r) => r.provider], [(r) => r.provider_account_id]).map((row) => ({
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
          const id = write.id;
          return tables.updateWhere(write.table, (r) => r.id === id, { content: write.content });
        }
        case 'chat_subagent_runs': {
          const id = write.id;
          const set = {
            ...(write.task !== undefined ? { task: write.task } : {}),
            ...(write.instructions !== undefined ? { instructions: write.instructions } : {}),
            ...(write.transcript !== undefined ? { transcript: write.transcript } : {}),
            ...(write.report !== undefined ? { report: write.report } : {}),
          };
          if (Object.keys(set).length === 0) return 0;
          return tables.update('chat_subagent_runs', (r) => r.id === id, set).length;
        }
        case 'artifacts': {
          const id = write.id;
          return tables.update('artifacts', (r) => r.id === id, {
            extracted_text: write.extractedText,
          }).length;
        }
        case 'chat_projects': {
          const id = write.id;
          return tables.update('chat_projects', (r) => r.id === id, {
            instructions: write.instructions,
          }).length;
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
          return tables.update(
            'provider_grants',
            (r) => r.provider === write.provider && r.provider_account_id === write.accountId,
            set
          ).length;
        }
        default:
          return tables.updateWhere(
            write.table,
            (r) => r.subject === write.subject && r.encrypted_credentials === write.stored,
            { encrypted_credentials: write.next }
          );
      }
    },
  };
}
