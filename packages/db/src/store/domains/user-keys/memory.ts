import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { UserKeyStore } from './types';

export function memoryUserKeys(tables: MemoryTables): UserKeyStore {
  return {
    async findKeyRow(subject) {
      const row = tables.first('user_encryption_keys', (r) => r.subject === subject);
      return row
        ? {
            version: row.version,
            mode: row.mode,
            publicKey: row.public_key,
            wrappedPrivateKey: row.wrapped_private_key,
            wrappedAutomationKey: row.wrapped_automation_key,
            enrolledAt: row.enrolled_at,
            verifier: row.verifier,
          }
        : null;
    },
    async liveDelegations(subject, instanceId, now) {
      const instance = tables.param('key_delegations', 'instance_id', instanceId);
      const rows = tables.select(
        'key_delegations',
        (r) =>
          r.subject === subject &&
          r.instance_id === instance &&
          r.expires_at.getTime() > now.getTime()
      );
      return orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id, 'desc']).map((row) => ({
        scope: row.scope,
        sessionId: row.session_id,
        sealedKey: row.sealed_key,
      }));
    },
    async delegationsOf(subject, now) {
      const rows = tables.select(
        'key_delegations',
        (r) => r.subject === subject && r.expires_at.getTime() > now.getTime()
      );
      return orderBy(rows, [(r) => r.created_at], [(r) => r.id]).map((row) => ({
        instanceId: row.instance_id,
        scope: row.scope,
        sessionId: row.session_id,
        expiresAt: row.expires_at,
      }));
    },
    async liveInstances(since) {
      const rows = tables.select(
        'delegate_instances',
        (r) => r.heartbeat_at.getTime() > since.getTime()
      );
      return orderBy(rows, [(r) => r.started_at], [(r) => r.id]).map((row) => ({
        id: row.id,
        publicKey: row.public_key,
      }));
    },
  };
}
