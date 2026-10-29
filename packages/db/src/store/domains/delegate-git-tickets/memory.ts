import type { MemoryTables } from '../../memory/tables';
import type { DelegateGitTicketStore } from './types';

export function memoryDelegateGitTickets(tables: MemoryTables): DelegateGitTicketStore {
  return {
    async insert(ticket) {
      tables.insert('delegate_git_tickets', {
        id: ticket.id,
        subject: ticket.subject,
        provider: ticket.provider,
        host: ticket.host,
        write: ticket.write,
        secret_hash: ticket.secretHash,
        expires_at: ticket.expiresAt,
        created_at: new Date(),
      });
    },
    async find(id) {
      const wanted = id;
      const row = tables.first('delegate_git_tickets', (r) => r.id === wanted);
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
      return tables.delete('delegate_git_tickets', (r) => r.expires_at.getTime() < before.getTime())
        .length;
    },
  };
}
