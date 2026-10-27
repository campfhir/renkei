import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { DelegateSigningKeyStore } from './types';

export function memoryDelegateSigningKeys(tables: MemoryTables): DelegateSigningKeyStore {
  return {
    async find() {
      const [row] = orderBy(
        tables.select('delegate_signing_keys'),
        [(r) => r.created_at],
        [(r) => r.id]
      );
      return row ? { publicKey: row.public_key, sealedPrivateKey: row.sealed_private_key } : null;
    },
    async insertIfAbsent(key) {
      return (
        tables.upsert(
          'delegate_signing_keys',
          { public_key: key.publicKey, sealed_private_key: key.sealedPrivateKey },
          ['singleton']
        ) !== undefined
      );
    },
  };
}
