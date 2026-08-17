import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { DB } from './db.types';

/**
 * Connection state anchored on globalThis, not the module cache. Next
 * bundles instrumentation.ts, the server routes, and the proxy as separate
 * compilation graphs; each evaluates this module separately, so plain
 * module-level state would mean one pool per graph. Functionally that mostly
 * works, but it is the same split-singleton surprise that left the log
 * table with only instrumentation's lines — one process, one pool.
 */
interface DbState {
  db: Kysely<DB> | null;
  pool: Pool | null;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForDb = globalThis as unknown as { __renkeiDbState?: DbState };
const state: DbState = (globalForDb.__renkeiDbState ??= { db: null, pool: null });

export function initDatabase(): Result<Pool, 'DB_INIT_ERROR'> {
  if (state.pool) return ok(state.pool);

  // Deliberately raw process.env, not a package-level config module: this
  // package is shared by web, worker and the migrate CLI, and DATABASE_URL is
  // the only setting it needs. Each app validates its own fuller config.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return err('DB_INIT_ERROR' as const);
  }

  try {
    state.pool = new Pool({ connectionString });
    return ok(state.pool);
  } catch {
    return err('DB_INIT_ERROR' as const);
  }
}

export function getDatabase(): Result<Kysely<DB>, 'DB_INIT_ERROR'> {
  if (state.db) return ok(state.db);

  const poolResult = initDatabase();
  if (!poolResult.ok) {
    return poolResult;
  }

  try {
    state.db = new Kysely({
      dialect: new PostgresDialect({ pool: poolResult.val }),
    });
    return ok(state.db);
  } catch {
    return err('DB_INIT_ERROR' as const);
  }
}

export function getPool(): Result<Pool, 'DB_INIT_ERROR'> {
  if (!state.pool) {
    return initDatabase();
  }
  return ok(state.pool);
}

export async function closeDatabase(): Promise<void> {
  if (state.db) {
    // Kysely's destroy ends the pool it wraps — the same pool state.pool
    // holds — and pg-pool throws on a second end() rather than ignoring it.
    // So a built db means destroy alone closes everything.
    await state.db.destroy();
    state.db = null;
    state.pool = null;
    return;
  }
  if (state.pool) {
    await state.pool.end();
    state.pool = null;
  }
}
