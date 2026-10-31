import { compareAsc, orderBy } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import type { IdentityRecord, IdentityStore } from './types';

function record(row: Row<'identities'>): IdentityRecord {
  return {
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    idpGroups: row.idp_groups ?? [],
  };
}

export function memoryIdentities(tables: MemoryTables): IdentityStore {
  return {
    async get(subject) {
      const row = tables.first('identities', (r) => r.subject === subject);
      return row ? record(row) : null;
    },
    async findByEmail(email) {
      const rows = tables.select('identities', (r) => r.email === email);
      return rows.length === 1 ? record(rows[0]) : null;
    },
    async upsert({ subject, email, displayName, idpGroups }) {
      tables.upsert(
        'identities',
        {
          subject,
          email,
          display_name: displayName,
          idp_groups: idpGroups,
          created_at: new Date(),
          updated_at: new Date(),
        },
        ['subject'],
        { email, display_name: displayName, idp_groups: idpGroups, updated_at: new Date() }
      );
    },
    async clearGroups(subject) {
      tables.update('identities', (r) => r.subject === subject, {
        idp_groups: [],
        updated_at: new Date(),
      });
    },
    async list() {
      return orderBy(tables.select('identities'), [(r) => r.display_name], [(r) => r.email]).map(
        record
      );
    },
    async listBySubjects(subjects) {
      const wanted = new Set(subjects);
      return orderBy(
        tables.select('identities', (r) => wanted.has(r.subject)),
        [(r) => r.subject]
      ).map(record);
    },
    async distinctGroups() {
      const values = new Set(tables.select('identities').flatMap((r) => r.idp_groups ?? []));
      return [...values].sort(compareAsc);
    },
  };
}
