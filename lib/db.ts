import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { getConfig } from './env';
import type { DB } from './db.types';

let db: Kysely<DB> | null = null;
let pool: Pool | null = null;

export function initDatabase(): Pool {
  if (pool) return pool;

  const config = getConfig();
  pool = new Pool({
    connectionString: config.DATABASE_URL,
  });

  return pool;
}

export function getDatabase(): Kysely<DB> {
  if (db) return db;

  const pool = initDatabase();
  db = new Kysely({
    dialect: new PostgresDialect({ pool }),
  });

  return db;
}

export function getPool(): Pool {
  if (!pool) {
    initDatabase();
  }
  return pool!;
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
