import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { DelegateGitTicketStore } from './types';

export function postgresDelegateGitTickets(db: () => Kysely<DB>): DelegateGitTicketStore {
  return {
    async insert(ticket) {
      await db()
        .insertInto('delegate_git_tickets')
        .values({
          id: ticket.id,
          subject: ticket.subject,
          provider: ticket.provider,
          host: ticket.host,
          write: ticket.write,
          secret_hash: ticket.secretHash,
          expires_at: ticket.expiresAt,
        })
        .execute();
    },
    async find(id) {
      const row = await db()
        .selectFrom('delegate_git_tickets')
        .select(['id', 'subject', 'provider', 'host', 'write', 'secret_hash', 'expires_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            subject: row.subject,
            provider: row.provider,
            host: row.host,
            write: row.write,
            secretHash: row.secret_hash,
            expiresAt: row.expires_at,
          }
        : null;
    },
    async deleteExpired(before) {
      const result = await db()
        .deleteFrom('delegate_git_tickets')
        .where('expires_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
