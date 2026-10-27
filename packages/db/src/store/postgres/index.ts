import type { Kysely } from 'kysely';
import type { DB } from '../../db.types';
import { DOMAINS } from '../domains';
import type { DataStore } from '../types';

/**
 * The production data store: every domain's Kysely repository. `db` is
 * resolved per call, not at construction, so building the store never
 * needs a connection and a missing DATABASE_URL surfaces where it always
 * did — as the failed query.
 */
export function createPostgresDataStore(db: () => Kysely<DB>): DataStore {
  const repositories = Object.fromEntries(
    Object.entries(DOMAINS).map(([key, domain]) => [key, domain.postgres(db)])
  );
  return assemble({ ...repositories, kind: 'postgres' as const });
}

// Built from DOMAINS key by key — the DataStore type's own definition.
function assemble<T>(store: T): DataStore {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return store as unknown as DataStore;
}
