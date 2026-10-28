/**
 * The differential harness: the same fixture rows and the same call, once
 * against a freshly truncated Postgres and once against a fresh memory
 * store, answers compared after normalization. Used by differential.test.ts
 * (Postgres vs memory, when CONTRACT_DATABASE_URL names a contract
 * database) and coverage.test.ts (memory against itself, always).
 *
 * The memory store is seeded with the fixture as Postgres stored it (every
 * column, defaults filled), so the two start from identical rows. The
 * contract database is TRUNCATED before every scenario, so the harness
 * refuses any database whose name does not end in `_contract`. Scenarios
 * use values that sort the same under a plain compare (the memory store's)
 * and under the database's collation:
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
import type { TableRows } from '../memory/tables';
import { createPostgresDataStore } from '../postgres';
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

/**
 * The scenario on a fresh memory store, seeded with `rows` when given (the
 * fixture as Postgres stored it, defaults filled) or else the fixture as
 * written.
 */
export async function runOnMemory(
  scenario: Scenario<DataStore>,
  rows: TableRows | undefined = scenario.fixture
): Promise<Outcome> {
  const store = createMemoryDataStore();
  if (rows) await store.seed(rows);
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

interface Catalog {
  tables: string[];
  /** For each table, the tables its foreign keys point at. */
  parents: Map<string, string[]>;
  /** For each table, its json and jsonb columns. */
  jsonColumns: Map<string, Set<string>>;
}

const catalogs = new WeakMap<Kysely<DB>, Promise<Catalog>>();

/** The contract database's tables, references and JSON columns, read once per connection. */
function catalogOf(db: Kysely<DB>): Promise<Catalog> {
  let catalog = catalogs.get(db);
  if (!catalog) {
    catalog = readCatalog(db);
    catalogs.set(db, catalog);
  }
  return catalog;
}

async function readCatalog(db: Kysely<DB>): Promise<Catalog> {
  const tables = await sql<{ name: string }>`
    SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('kysely_migration', 'kysely_migration_lock')
    ORDER BY tablename`.execute(db);
  const references = await sql<{ child: string; parent: string }>`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'`.execute(db);
  const json = await sql<{ table_name: string; column_name: string }>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')`.execute(db);
  const parents = new Map<string, string[]>();
  for (const { child, parent } of references.rows) {
    parents.set(child, [...(parents.get(child) ?? []), parent]);
  }
  const jsonColumns = new Map<string, Set<string>>();
  for (const row of json.rows) {
    const columns = jsonColumns.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    jsonColumns.set(row.table_name, columns);
  }
  return { tables: tables.rows.map((row) => row.name), parents, jsonColumns };
}

/** Tables ordered so every parent comes before the tables that reference it. */
function insertionOrder(tables: string[], parents: Map<string, string[]>): string[] {
  const wanted = new Set(tables);
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (table: string) => {
    if (ordered.includes(table) || visiting.has(table)) return;
    visiting.add(table);
    for (const parent of parents.get(table) ?? []) {
      if (wanted.has(parent) && parent !== table) visit(parent);
    }
    visiting.delete(table);
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
}

export async function truncateAll(db: Kysely<DB>): Promise<void> {
  const { tables } = await catalogOf(db);
  const list = tables.map((table) => `"${table}"`).join(', ');
  await sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`).execute(db);
}

/**
 * The fixture into Postgres, parents first. Fixture rows hold values as
 * the store reads them back (parsed JSON, Dates); a JSON column's value
 * goes as JSON text (pg would send a JS array as a Postgres array literal),
 * everything else as given.
 */
export async function seedPostgres(db: Kysely<DB>, fixtures: TableRows): Promise<void> {
  const { parents, jsonColumns } = await catalogOf(db);
  for (const table of insertionOrder(Object.keys(fixtures), parents)) {
    const rows: unknown = Reflect.get(fixtures, table);
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const json = jsonColumns.get(table) ?? new Set<string>();
    for (const row of rows) {
      const values: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(Object(row))) {
        if (value === undefined) continue;
        values[column] = json.has(column) && value !== null ? JSON.stringify(value) : value;
      }
      const names = Object.keys(values);
      await sql`INSERT INTO ${sql.table(table)} (${sql.join(names.map((n) => sql.ref(n)))})
        VALUES (${sql.join(names.map((n) => values[n]))})`.execute(db);
    }
  }
}

/** Every row of the fixture's tables, as Postgres stored them (defaults filled). */
async function storedRows(db: Kysely<DB>, fixtures: TableRows): Promise<TableRows> {
  const rows: TableRows = {};
  for (const table of Object.keys(fixtures)) {
    const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(
      db
    );
    // Each row exactly as the store's own Postgres reads would see it.
    Reflect.set(rows, table, result.rows);
  }
  return rows;
}

/**
 * The scenario on a freshly truncated Postgres. Besides the outcome, the
 * fixture as Postgres stored it — the rows the memory store is seeded
 * with, so both start from identical rows whatever defaults the fixture
 * left to the database.
 */
export async function runOnPostgres(
  database: ContractDatabase,
  scenario: Scenario<DataStore>
): Promise<{ outcome: Outcome; rows: TableRows | undefined }> {
  await truncateAll(database.db);
  let rows: TableRows | undefined;
  if (scenario.fixture) {
    await seedPostgres(database.db, scenario.fixture);
    rows = await storedRows(database.db, scenario.fixture);
  }
  const store = createPostgresDataStore(() => database.db);
  return { outcome: await outcomeOf(() => scenario.run(store)), rows };
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
