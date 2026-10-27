import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { DB } from './db.types';
import { memoryDataStoreRequested } from './store/selection';

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
  /** On the memory store: each direct reach for the database, by calling frame. */
  directCalls: Map<string, number>;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForDb = globalThis as unknown as { __renkeiDbState?: DbState };
const state: DbState = (globalForDb.__renkeiDbState ??= {
  db: null,
  pool: null,
  directCalls: new Map(),
});
state.directCalls ??= new Map();

/**
 * Remember who reached for the database on the memory store: the first
 * three calling functions outside this module (bundled code has no useful
 * paths, but keeps names). The memory UI suite's crawl
 * (apps/web/e2e/memory/crawl.spec.ts) reads these through the test seed
 * route to prove a page renders from the data store alone.
 */
function recordDirectCall(): void {
  const callers = (new Error().stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(
      (frame) => !/recordDirectCall|initDatabase|getDatabase|getPool|node:internal/.test(frame)
    )
    .slice(0, 3)
    .map((frame) => /^at (?:async )?([^\s(]+)/.exec(frame)?.[1] ?? frame);
  const caller = callers.join(' < ') || 'unknown';
  state.directCalls.set(caller, (state.directCalls.get(caller) ?? 0) + 1);
}

/** Direct database calls made on the memory store since the last reset, by caller. */
export function directDatabaseCalls(): { caller: string; count: number }[] {
  return [...state.directCalls].map(([caller, count]) => ({ caller, count }));
}

export function resetDirectDatabaseCalls(): void {
  state.directCalls.clear();
}

export function initDatabase(): Result<Pool, 'DB_INIT_ERROR'> {
  if (state.pool) return ok(state.pool);

  // A process on the in-memory data store (store/registry.ts) has no
  // database by design: code that still queries directly sees it the way
  // it sees an outage, never a real database the env happens to name.
  if (memoryDataStoreRequested()) {
    recordDirectCall();
    return err('DB_INIT_ERROR' as const);
  }

  // Deliberately raw process.env, not a package-level config module: this
  // package is shared by web, worker and the migrate CLI, and DATABASE_URL is
  // the only setting it needs. Each app validates its own fuller config.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return err('DB_INIT_ERROR' as const);
  }

  try {
    state.pool = new Pool({ connectionString });
    // An IDLE connection dying (Postgres restart, network drop, server-side
    // reap) emits the pool's 'error' event. Without a listener Node treats
    // it as an unhandled 'error' and KILLS THE PROCESS — dumping the raw pg
    // client — so a routine database restart became a worker crash-loop.
    // Handled, pg-pool simply discards the dead client and the next query
    // checks out a fresh connection. console.error, not a logger: this
    // package sits below every app's logging stack.
    state.pool.on('error', (error) => {
      console.error(
        `[db] idle connection error (recovering): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
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
