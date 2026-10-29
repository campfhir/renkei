import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../db.types';
import { USER_KEY_SEALED_ORDER, USER_KEY_SEALED_TABLES } from './sealed';
import type { UserKeyDelegationWrite, UserKeySealedRows, UserKeyStore } from './types';

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
    async registerInstance(id, publicKey) {
      await db().insertInto('delegate_instances').values({ id, public_key: publicKey }).execute();
    },
    async heartbeatInstance(id, at) {
      await db()
        .updateTable('delegate_instances')
        .set({ heartbeat_at: at })
        .where('id', '=', id)
        .execute();
    },
    async deleteStaleInstances(before) {
      const result = await db()
        .deleteFrom('delegate_instances')
        .where('heartbeat_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async deleteInstance(id) {
      const result = await db()
        .deleteFrom('delegate_instances')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async writeDelegations(subject, write) {
      await db()
        .transaction()
        .execute((trx) => writeDelegations(trx, subject, write));
    },
    async revokeAutomation(subject) {
      const result = await db()
        .deleteFrom('key_delegations')
        .where('subject', '=', subject)
        .where('scope', '=', 'automation')
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async shred(subject) {
      return db()
        .transaction()
        .execute(async (trx) => {
          await trx
            .deleteFrom('resource_key_grants')
            .where('holder', '=', subject)
            .where('holder_kind', 'in', ['user', 'automation', 'public'])
            .execute();
          const result = await trx
            .deleteFrom('user_encryption_keys')
            .where('subject', '=', subject)
            .executeTakeFirst();
          return Number(result.numDeletedRows) > 0;
        });
    },
    async countByMode() {
      const rows = await db()
        .selectFrom('user_encryption_keys')
        .select(['mode', (eb) => eb.fn.countAll<string>().as('count')])
        .groupBy('mode')
        .orderBy('mode')
        .execute();
      return rows.map((row) => ({ mode: row.mode, count: Number(row.count) }));
    },
    async ensureLegacyRow(subject, salt) {
      await db()
        .insertInto('user_encryption_keys')
        .values({ subject, salt })
        .onConflict((oc) => oc.columns(['subject']).doNothing())
        .execute();
      return db()
        .selectFrom('user_encryption_keys')
        .select(['salt', 'mode', 'version'])
        .where('subject', '=', subject)
        .executeTakeFirstOrThrow();
    },
    async changeKeys(subject, plan) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const row = await trx
            .selectFrom('user_encryption_keys')
            .select(['salt', 'mode', 'version', 'verifier', 'sealed_kek', 'unlocked_until'])
            .where('subject', '=', subject)
            .forUpdate()
            .executeTakeFirst();
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
          const decided = await plan(current, () => readSealed(trx, subject));
          if (!decided.commit) return decided.answer;
          for (const wrapping of decided.rewrite.wrappings) {
            await trx
              .updateTable('resource_key_grants')
              .set({ wrapped_key: wrapping.wrappedKey, kek_version: wrapping.kekVersion })
              .where('resource_key_id', '=', wrapping.resourceKeyId)
              .where('holder_kind', '=', wrapping.holderKind)
              .where('holder', '=', subject)
              .execute();
          }
          for (const value of decided.rewrite.values) {
            const spec = USER_KEY_SEALED_TABLES[value.table];
            const assignments = Object.entries(value.values)
              .filter(([column]) => spec.columns.includes(column))
              .map(([column, next]) => sql`${sql.ref(column)} = ${next}`);
            if (assignments.length === 0) continue;
            const identity = spec.idColumns.map(
              (column, i) => sql`${sql.ref(column)} = ${value.id[i] ?? ''}`
            );
            await sql`
              UPDATE ${sql.table(value.table)} SET ${sql.join(assignments)}
               WHERE ${sql.ref(spec.subjectColumn)} = ${subject}
                 AND ${sql.join(identity, sql` AND `)}
            `.execute(trx);
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
            await trx
              .insertInto('user_encryption_keys')
              .values({ subject, salt: change.salt, ...held, rotated_at: change.rotatedAt })
              .onConflict((oc) =>
                oc.columns(['subject']).doUpdateSet({ ...held, rotated_at: change.enrolledAt })
              )
              .execute();
          } else {
            await trx
              .updateTable('user_encryption_keys')
              .set({
                version: change.version,
                wrapped_private_key: change.wrappedPrivateKey,
                wrapped_automation_key: change.wrappedAutomationKey,
                rotated_at: change.rotatedAt,
              })
              .where('subject', '=', subject)
              .execute();
          }
          if (decided.dropDelegations) {
            await trx.deleteFrom('key_delegations').where('subject', '=', subject).execute();
          }
          await writeDelegations(trx, subject, decided.delegations);
          return decided.answer;
        });
    },
  };
}

async function writeDelegations(
  trx: Transaction<DB>,
  subject: string,
  write: UserKeyDelegationWrite
): Promise<void> {
  const known = new Set(
    (await trx.selectFrom('delegate_instances').select('id').execute()).map((row) => row.id)
  );
  await trx
    .deleteFrom('key_delegations')
    .where('subject', '=', subject)
    .where('scope', '=', 'session')
    .where('session_id', '=', write.sessionId)
    .execute();
  const session = write.session.filter((entry) => known.has(entry.instanceId));
  if (session.length > 0) {
    await trx
      .insertInto('key_delegations')
      .values(
        session.map((entry) => ({
          subject,
          instance_id: entry.instanceId,
          scope: 'session',
          session_id: write.sessionId,
          sealed_key: entry.sealedKey,
          expires_at: write.sessionExpiresAt,
        }))
      )
      .execute();
  }
  const automation = write.automation.filter((entry) => known.has(entry.instanceId));
  if (automation.length > 0) {
    await trx
      .deleteFrom('key_delegations')
      .where('subject', '=', subject)
      .where('scope', '=', 'automation')
      .execute();
    await trx
      .insertInto('key_delegations')
      .values(
        automation.map((entry) => ({
          subject,
          instance_id: entry.instanceId,
          scope: 'automation',
          session_id: null,
          sealed_key: entry.sealedKey,
          expires_at: write.automationExpiresAt,
        }))
      )
      .execute();
  }
}

/** Everything sealed for the person, locked for the transaction's change. */
async function readSealed(trx: Transaction<DB>, subject: string): Promise<UserKeySealedRows> {
  const wrappings = await trx
    .selectFrom('resource_key_grants')
    .select(['resource_key_id', 'holder_kind', 'wrapped_key'])
    .where('holder', '=', subject)
    .where('holder_kind', 'in', ['user', 'automation'])
    .orderBy('resource_key_id')
    .orderBy('holder_kind')
    .forUpdate()
    .execute();
  const values: UserKeySealedRows['values'] = [];
  for (const table of USER_KEY_SEALED_ORDER) {
    const spec = USER_KEY_SEALED_TABLES[table];
    // The schema types are per table; the walk is the same for each, so it
    // is written once as SQL over identifiers rather than five typed copies.
    const ids = spec.idColumns.map((column) => sql.ref(column));
    const selected = [...spec.idColumns, ...spec.columns].map((column) => sql.ref(column));
    const rows = await sql<Record<string, unknown>>`
      SELECT ${sql.join(selected)} FROM ${sql.table(table)}
       WHERE ${sql.ref(spec.subjectColumn)} = ${subject}
       ORDER BY ${sql.join(ids)}
       FOR UPDATE
    `.execute(trx);
    for (const row of rows.rows) {
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
