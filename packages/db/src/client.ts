import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { DB } from './db.types';

let db: Kysely<DB> | null = null;
let pool: Pool | null = null;

export function initDatabase(): Result<Pool, 'DB_INIT_ERROR'> {
  if (pool) return ok(pool);

  // Deliberately raw process.env, not a package-level config module: this
  // package is shared by web, worker and the migrate CLI, and DATABASE_URL is
  // the only setting it needs. Each app validates its own fuller config.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return err('DB_INIT_ERROR' as const);
  }

  try {
    pool = new Pool({ connectionString });
    return ok(pool);

  } catch  {
    return err('DB_INIT_ERROR' as const);
  }
}

export function getDatabase(): Result<Kysely<DB>, 'DB_INIT_ERROR'> {
  if (db) return ok(db);

  const poolResult = initDatabase();
  if (!poolResult.ok) {
    return poolResult;
  }

  try {
    db = new Kysely({
      dialect: new PostgresDialect({ pool: poolResult.val }),
    });
    return ok(db);

  } catch  {
    return err('DB_INIT_ERROR' as const);
  }
}

export function getPool(): Result<Pool, 'DB_INIT_ERROR'> {
  if (!pool) {
    return initDatabase();
  }
  return ok(pool);
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}
