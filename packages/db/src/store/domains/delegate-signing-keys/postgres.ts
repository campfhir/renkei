import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { DelegateSigningKeyStore } from './types';

export function postgresDelegateSigningKeys(db: () => Kysely<DB>): DelegateSigningKeyStore {
  return {
    async find() {
      const row = await db()
        .selectFrom('delegate_signing_keys')
        .select(['public_key', 'sealed_private_key'])
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      return row ? { publicKey: row.public_key, sealedPrivateKey: row.sealed_private_key } : null;
    },
    async insertIfAbsent(key) {
      const inserted = await db()
        .insertInto('delegate_signing_keys')
        .values({ public_key: key.publicKey, sealed_private_key: key.sealedPrivateKey })
        .onConflict((oc) => oc.column('singleton').doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
  };
}
