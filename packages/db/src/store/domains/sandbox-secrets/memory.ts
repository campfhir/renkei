import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { sandboxSecretFromRow, sandboxSecretValues } from './record';
import type { SandboxSecretStore } from './types';

export function memorySandboxSecrets(tables: MemoryTables): SandboxSecretStore {
  const id = (value: string) => tables.param('sandbox_secrets', 'id', value);
  return {
    async insert(secret) {
      return sandboxSecretFromRow(tables.insert('sandbox_secrets', sandboxSecretValues(secret)));
    },
    async list(subject) {
      const rows = tables.select('sandbox_secrets', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.name]).map(sandboxSecretFromRow);
    },
    async count(subject) {
      return tables.select('sandbox_secrets', (r) => r.subject === subject).length;
    },
    async get(subject, secretId) {
      const wanted = id(secretId);
      const row = tables.first('sandbox_secrets', (r) => r.subject === subject && r.id === wanted);
      return row ? sandboxSecretFromRow(row) : null;
    },
    async getByName(subject, name) {
      const row = tables.first('sandbox_secrets', (r) => r.subject === subject && r.name === name);
      return row ? sandboxSecretFromRow(row) : null;
    },
    async touchUsed(secretId, at) {
      const wanted = id(secretId);
      tables.update('sandbox_secrets', (r) => r.id === wanted, { last_used_at: at });
    },
    async delete(subject, secretId) {
      const wanted = id(secretId);
      const [row] = tables.delete(
        'sandbox_secrets',
        (r) => r.subject === subject && r.id === wanted
      );
      return row ? { id: row.id, name: row.name } : null;
    },
    async listExpiredIds(before, limit) {
      const rows = tables.select(
        'sandbox_secrets',
        (r) => r.expires_at.getTime() < before.getTime()
      );
      return page(orderBy(rows, [(r) => r.expires_at], [(r) => r.id]), limit).map((r) => r.id);
    },
    async deleteById(secretId) {
      const wanted = id(secretId);
      tables.delete('sandbox_secrets', (r) => r.id === wanted);
    },
  };
}
