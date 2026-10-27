import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { envSecretFromRow } from './record';
import type { SandboxEnvSecretStore } from './types';

export function memorySandboxEnvSecrets(tables: MemoryTables): SandboxEnvSecretStore {
  const byName = (subject: string) =>
    orderBy(
      tables.select('sandbox_env_secrets', (r) => r.subject === subject),
      [(r) => r.name]
    );
  return {
    async upsert(secret) {
      const row = tables.upsert(
        'sandbox_env_secrets',
        { id: secret.id, subject: secret.subject, name: secret.name, sealed: secret.sealed },
        ['subject', 'name'],
        { sealed: secret.sealed, updated_at: secret.updatedAt }
      );
      if (!row) throw new Error('sandbox_env_secrets upsert returned nothing');
      return envSecretFromRow(row);
    },
    async list(subject) {
      return byName(subject).map(envSecretFromRow);
    },
    async count(subject) {
      return tables.select('sandbox_env_secrets', (r) => r.subject === subject).length;
    },
    async has(subject, name) {
      return (
        tables.first('sandbox_env_secrets', (r) => r.subject === subject && r.name === name) !==
        undefined
      );
    },
    async listSealed(subject) {
      return byName(subject).map((row) => ({ id: row.id, name: row.name, sealed: row.sealed }));
    },
    async touchUsed(ids, at) {
      const wanted = new Set(ids.map((id) => tables.param('sandbox_env_secrets', 'id', id)));
      tables.update('sandbox_env_secrets', (r) => wanted.has(r.id), { last_used_at: at });
    },
    async delete(subject, name) {
      const [row] = tables.delete(
        'sandbox_env_secrets',
        (r) => r.subject === subject && r.name === name
      );
      return row ? { id: row.id, name: row.name } : null;
    },
  };
}
