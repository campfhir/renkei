/**
 * The differential harness: the same fixture rows and the same call, once
 * against a freshly truncated Postgres and once against a fresh memory
 * store, answers compared after normalization. Used by differential.test.ts
 * (Postgres vs memory, when CONTRACT_DATABASE_URL names a contract
 * database) and coverage.test.ts (memory against itself, always).
 *
 * The contract database is created with ICU en-US collation — the
 * collation memory/order.ts sorts by — and is TRUNCATED before every
 * scenario, so the harness refuses any database whose name does not end
 * in `_contract`:
 *
 *   CREATE DATABASE renkei_contract TEMPLATE template0
 *     LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C.UTF-8';
 *   DATABASE_URL=…/renkei_contract pnpm --filter @renkei/db migrate
 *   CONTRACT_DATABASE_URL=…/renkei_contract pnpm --filter @renkei/db test:contract
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../../db.types';
import type { Scenario } from '../domain';
import { createMemoryDataStore } from '../memory';
import { MemoryTables, type TableRows } from '../memory/tables';
import { createPostgresDataStore } from '../postgres';
import { STORE_SCHEMA } from '../schema.generated';
import type { DataStore } from '../types';

/** An answer made comparable: Dates, bytes and Maps as plain data, undefined fields dropped. */
export function normalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
  }
  if (value instanceof Date)
    return { $date: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') };
  }
  if (value instanceof Map) {
    return {
      $map: [...value.entries()]
        .map(([k, v]) => [normalize(k), normalize(v)])
        .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))),
    };
  }
  if (value instanceof Set) {
    return {
      $set: [...value]
        .map(normalize)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }
  if (Array.isArray(value)) return value.map(normalize);
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) out[key] = normalize(field);
  }
  return out;
}

/** What a scenario produced: its normalized answer, or the fact (and SQLSTATE) of its failure. */
export type Outcome = { ok: true; value: unknown } | { ok: false; code: string | null };

export async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: normalize(await run()) };
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    return { ok: false, code };
  }
}

export async function runOnMemory(scenario: Scenario<DataStore>): Promise<Outcome> {
  const store = createMemoryDataStore();
  if (scenario.fixture) await store.seed(scenario.fixture);
  return outcomeOf(() => scenario.run(store));
}

export interface ContractDatabase {
  db: Kysely<DB>;
  close(): Promise<void>;
}

export function openContractDatabase(url: string): ContractDatabase {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_contract')) {
    throw new Error(
      `CONTRACT_DATABASE_URL names "${name}": the differential suite truncates every table, ` +
        'so it only runs against a database whose name ends in _contract.'
    );
  }
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
  });
  return { db, close: () => db.destroy() };
}

const ALL_TABLES = Object.keys(STORE_SCHEMA);

export async function truncateAll(db: Kysely<DB>): Promise<void> {
  const list = ALL_TABLES.map((table) => `"${table}"`).join(', ');
  await sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`).execute(db);
}

/**
 * The fixture into Postgres, parents first. jsonb values that are not
 * already JSON text are encoded (pg would send a JS array as a Postgres
 * array literal); everything else goes as given — the memory store reads
 * the same values through the same rules.
 */
export async function seedPostgres(db: Kysely<DB>, fixtures: TableRows): Promise<void> {
  const order = new MemoryTables().insertionOrder(Object.keys(fixtures));
  for (const table of order) {
    const rows: unknown = Reflect.get(fixtures, table);
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const columns = STORE_SCHEMA[table].columns;
    for (const row of rows) {
      const values: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(Object(row))) {
        const type = columns[column]?.type;
        values[column] =
          (type === 'jsonb' || type === 'json') && value !== null && typeof value !== 'string'
            ? JSON.stringify(value)
            : value;
      }
      const names = Object.keys(values);
      await sql`INSERT INTO ${sql.table(table)} (${sql.join(names.map((n) => sql.ref(n)))})
        VALUES (${sql.join(names.map((n) => values[n]))})`.execute(db);
    }
  }
}

export async function runOnPostgres(
  database: ContractDatabase,
  scenario: Scenario<DataStore>
): Promise<Outcome> {
  await truncateAll(database.db);
  if (scenario.fixture) await seedPostgres(database.db, scenario.fixture);
  const store = createPostgresDataStore(() => database.db);
  return outcomeOf(() => scenario.run(store));
}

/** `domain.method` for every method of every repository the store has. */
export function storeMethods(store: DataStore): string[] {
  const methods: string[] = [];
  for (const [key, repository] of Object.entries(store)) {
    if (typeof repository !== 'object' || repository === null || key === 'tables') continue;
    for (const [name, member] of Object.entries(repository)) {
      if (typeof member === 'function') methods.push(`${key}.${name}`);
    }
  }
  return methods.sort();
}
