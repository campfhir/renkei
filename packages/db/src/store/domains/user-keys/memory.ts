import { orderBy, type OrderTerm } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { USER_KEY_SEALED_ORDER, USER_KEY_SEALED_TABLES } from './sealed';
import type { UserKeyDelegationWrite, UserKeySealedRows, UserKeyStore } from './types';

export function memoryUserKeys(tables: MemoryTables): UserKeyStore {
  /** Delegate instances, and the key delegations sealed to them. */
  const deleteInstances = (where: (r: Row<'delegate_instances'>) => boolean) => {
    const gone = new Set(tables.delete('delegate_instances', where).map((r) => r.id));
    tables.delete('key_delegations', (r) => gone.has(r.instance_id));
    return gone.size;
  };
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
      const instance = instanceId;
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
    async registerInstance(id, publicKey) {
      const now = new Date();
      tables.insert('delegate_instances', {
        id,
        public_key: publicKey,
        started_at: now,
        heartbeat_at: now,
      });
    },
    async heartbeatInstance(id, at) {
      const instance = id;
      tables.update('delegate_instances', (r) => r.id === instance, { heartbeat_at: at });
    },
    async deleteStaleInstances(before) {
      return deleteInstances((r) => r.heartbeat_at.getTime() < before.getTime());
    },
    async deleteInstance(id) {
      const instance = id;
      return deleteInstances((r) => r.id === instance);
    },
    async writeDelegations(subject, write) {
      writeDelegations(subject, write);
    },
    async revokeAutomation(subject) {
      return tables.delete(
        'key_delegations',
        (r) => r.subject === subject && r.scope === 'automation'
      ).length;
    },
    async shred(subject) {
      tables.delete(
        'resource_key_grants',
        (r) => r.holder === subject && HELD_OR_PUBLIC.includes(r.holder_kind)
      );
      tables.delete('key_delegations', (r) => r.subject === subject);
      return tables.delete('user_encryption_keys', (r) => r.subject === subject).length > 0;
    },
    async countByMode() {
      const counts = new Map<string, number>();
      for (const row of tables.select('user_encryption_keys')) {
        counts.set(row.mode, (counts.get(row.mode) ?? 0) + 1);
      }
      return orderBy(
        [...counts].map(([mode, count]) => ({ mode, count })),
        [(r) => r.mode]
      );
    },
    async ensureLegacyRow(subject, salt) {
      tables.upsert(
        'user_encryption_keys',
        {
          subject,
          salt,
          mode: 'managed',
          version: 1,
          public_key: null,
          wrapped_private_key: null,
          wrapped_automation_key: null,
          enrolled_at: null,
          rotated_at: null,
          verifier: null,
          sealed_kek: null,
          unlocked_until: null,
          created_at: new Date(),
        },
        ['subject']
      );
      const row = tables.first('user_encryption_keys', (r) => r.subject === subject);
      if (!row) throw new Error('no result');
      return { salt: row.salt, mode: row.mode, version: row.version };
    },
    async changeKeys(subject, plan) {
      const row = tables.first('user_encryption_keys', (r) => r.subject === subject);
      const current = row
        ? {
            salt: row.salt,
            mode: row.mode,
            version: row.version,
            verifier: row.verifier,
            sealedKek: row.sealed_kek,
            unlockedUntil: row.unlocked_until,
          }
        : null;
      const decided = await plan(current, async () => readSealed(subject));
      if (!decided.commit) return decided.answer;
      for (const wrapping of decided.rewrite.wrappings) {
        const keyId = wrapping.resourceKeyId;
        tables.update(
          'resource_key_grants',
          (r) =>
            r.resource_key_id === keyId &&
            r.holder_kind === wrapping.holderKind &&
            r.holder === subject,
          { wrapped_key: wrapping.wrappedKey, kek_version: wrapping.kekVersion }
        );
      }
      for (const value of decided.rewrite.values) {
        const spec = USER_KEY_SEALED_TABLES[value.table];
        const changes = Object.fromEntries(
          Object.entries(value.values).filter(([column]) => spec.columns.includes(column))
        );
        if (Object.keys(changes).length === 0) continue;
        tables.updateWhere(
          value.table,
          (r) =>
            r[spec.subjectColumn] === subject &&
            spec.idColumns.every((column, i) => String(r[column]) === value.id[i]),
          changes
        );
      }
      const change = decided.keyRow;
      if (change.kind === 'enroll') {
        const held = {
          mode: 'held',
          version: change.version,
          public_key: change.publicKey,
          wrapped_private_key: change.wrappedPrivateKey,
          wrapped_automation_key: change.wrappedAutomationKey,
          enrolled_at: change.enrolledAt,
          verifier: change.verifier,
          sealed_kek: null,
          unlocked_until: null,
        };
        tables.upsert(
          'user_encryption_keys',
          {
            subject,
            salt: change.salt,
            ...held,
            rotated_at: change.rotatedAt,
            created_at: new Date(),
          },
          ['subject'],
          { ...held, rotated_at: change.enrolledAt }
        );
      } else {
        tables.update('user_encryption_keys', (r) => r.subject === subject, {
          version: change.version,
          wrapped_private_key: change.wrappedPrivateKey,
          wrapped_automation_key: change.wrappedAutomationKey,
          rotated_at: change.rotatedAt,
        });
      }
      if (decided.dropDelegations) tables.delete('key_delegations', (r) => r.subject === subject);
      writeDelegations(subject, decided.delegations);
      return decided.answer;
    },
  };

  function writeDelegations(subject: string, write: UserKeyDelegationWrite): void {
    const known = new Set(tables.select('delegate_instances').map((row) => row.id));
    const session = write.sessionId;
    tables.delete(
      'key_delegations',
      (r) => r.subject === subject && r.scope === 'session' && r.session_id === session
    );
    // As the Postgres set compares them: the id strings, not uuids.
    const isKnown = (entry: { instanceId: string }) => known.has(entry.instanceId);
    const sessionRows = write.session.filter(isKnown);
    if (sessionRows.length > 0) {
      for (const entry of sessionRows) {
        tables.insert('key_delegations', {
          id: globalThis.crypto.randomUUID(),
          subject,
          instance_id: entry.instanceId,
          scope: 'session',
          session_id: write.sessionId,
          sealed_key: entry.sealedKey,
          expires_at: write.sessionExpiresAt,
          created_at: new Date(),
        });
      }
    }
    const automation = write.automation.filter(isKnown);
    if (automation.length > 0) {
      tables.delete('key_delegations', (r) => r.subject === subject && r.scope === 'automation');
      for (const entry of automation) {
        tables.insert('key_delegations', {
          id: globalThis.crypto.randomUUID(),
          subject,
          instance_id: entry.instanceId,
          scope: 'automation',
          session_id: null,
          sealed_key: entry.sealedKey,
          expires_at: write.automationExpiresAt,
          created_at: new Date(),
        });
      }
    }
  }

  function readSealed(subject: string): UserKeySealedRows {
    const wrappings = orderBy(
      tables.select(
        'resource_key_grants',
        (r) => r.holder === subject && (r.holder_kind === 'user' || r.holder_kind === 'automation')
      ),
      [(r) => r.resource_key_id],
      [(r) => r.holder_kind]
    );
    const values: UserKeySealedRows['values'] = [];
    for (const table of USER_KEY_SEALED_ORDER) {
      const spec = USER_KEY_SEALED_TABLES[table];
      const rows = orderBy(
        tables.selectWhere(table, (r) => r[spec.subjectColumn] === subject),
        ...spec.idColumns.map((column): OrderTerm<Record<string, unknown>> => [(r) => r[column]])
      );
      for (const row of rows) {
        values.push({
          table,
          id: spec.idColumns.map((column) => String(row[column])),
          values: Object.fromEntries(
            spec.columns.map((column) => {
              const stored = row[column];
              return [column, typeof stored === 'string' ? stored : null];
            })
          ),
        });
      }
    }
    return {
      wrappings: wrappings.map((row) => ({
        resourceKeyId: row.resource_key_id,
        holderKind: row.holder_kind,
        wrappedKey: row.wrapped_key,
      })),
      values,
    };
  }
}

const HELD_OR_PUBLIC: readonly string[] = ['user', 'automation', 'public'];
