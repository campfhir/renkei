import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { AdvisoryLockStore } from './types';

export function postgresAdvisoryLocks(db: () => Kysely<DB>): AdvisoryLockStore {
  return {
    async withTryLock(namespace, name, fn) {
      // Session-level locks, taken and released on ONE pinned connection:
      // an advisory lock belongs to the connection that took it, so
      // releasing through the pool at large would unlock some other
      // session's lock (or nothing).
      return db()
        .connection()
        .execute(async (conn) => {
          const locked = await sql<{ locked: boolean }>`
            SELECT pg_try_advisory_lock(hashtext(${namespace}), hashtext(${name})) AS locked
          `.execute(conn);
          if (!locked.rows[0]?.locked) return false;
          try {
            await fn();
          } finally {
            await sql`
              SELECT pg_advisory_unlock(hashtext(${namespace}), hashtext(${name}))
            `.execute(conn);
          }
          return true;
        });
    },
  };
}
