import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { getConfig } from './env';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { DB } from './db.types';

let db: Kysely<DB> | null = null;
let pool: Pool | null = null;

export function initDatabase(): Result<Pool, 'DB_INIT_ERROR'> {
  if (pool) return ok(pool);

  const configResult = getConfig();
  if (!configResult.ok) {
    return err('DB_INIT_ERROR' as const);
  }

  try {
    pool = new Pool({
      connectionString: configResult.val.DATABASE_URL,
    });
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
