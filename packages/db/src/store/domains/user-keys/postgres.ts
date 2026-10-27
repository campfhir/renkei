import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { UserKeyStore } from './types';

export function postgresUserKeys(db: () => Kysely<DB>): UserKeyStore {
  return {
    async findKeyRow(subject) {
      const row = await db()
        .selectFrom('user_encryption_keys')
        .select([
          'version',
          'mode',
          'public_key',
          'wrapped_private_key',
          'wrapped_automation_key',
          'enrolled_at',
          'verifier',
        ])
        .where('subject', '=', subject)
        .executeTakeFirst();
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
      const rows = await db()
        .selectFrom('key_delegations')
        .select(['scope', 'session_id', 'sealed_key'])
        .where('subject', '=', subject)
        .where('instance_id', '=', instanceId)
        .where('expires_at', '>', now)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return rows.map((row) => ({
        scope: row.scope,
        sessionId: row.session_id,
        sealedKey: row.sealed_key,
      }));
    },
    async delegationsOf(subject, now) {
      const rows = await db()
        .selectFrom('key_delegations')
        .select(['instance_id', 'scope', 'session_id', 'expires_at'])
        .where('subject', '=', subject)
        .where('expires_at', '>', now)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        instanceId: row.instance_id,
        scope: row.scope,
        sessionId: row.session_id,
        expiresAt: row.expires_at,
      }));
    },
    async liveInstances(since) {
      const rows = await db()
        .selectFrom('delegate_instances')
        .select(['id', 'public_key'])
        .where('heartbeat_at', '>', since)
        .orderBy('started_at', 'asc')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({ id: row.id, publicKey: row.public_key }));
    },
  };
}
