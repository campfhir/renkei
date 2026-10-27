/**
 * Generate src/store/schema.generated.ts from a migrated database: every
 * table's columns (type, nullability, default), primary key, unique
 * constraints and foreign keys. The in-memory data store
 * (src/store/memory/) reads it to fill defaults the way Postgres does,
 * refuse a duplicate key or a dangling reference, and cascade a delete —
 * so the memory store's tables behave like the real ones without anyone
 * restating the schema by hand.
 *
 * Run after a migration, alongside db:types:
 *   pnpm --filter @renkei/db db:store-schema
 * CI regenerates it against a freshly migrated database and fails on a
 * diff, the same way the migration list is held to the files on disk.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/store/schema.generated.ts');

type Default =
  { kind: 'now' } | { kind: 'uuid' } | { kind: 'serial' } | { kind: 'value'; value: unknown };

interface Column {
  type: string;
  nullable: boolean;
  default: Default | null;
}

interface ForeignKey {
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
}

interface Table {
  columns: Record<string, Column>;
  primaryKey: string[];
  unique: string[][];
  foreignKeys: ForeignKey[];
}

/** One `'text'::type` / ARRAY[...] / number / boolean literal, as the value Postgres would store. */
function parseLiteral(raw: string, udt: string): unknown {
  const text = raw.trim();
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    // int8 and numeric come back from pg as strings.
    return udt === 'int8' || udt === 'numeric' ? text : Number(text);
  }
  const array = /^ARRAY\[(.*?)\](?:::[\w ]+\[\])?$/.exec(text);
  if (array) {
    if (array[1].trim() === '') return [];
    return array[1].split(',').map((part) => parseLiteral(part, udt.replace(/^_/, '')));
  }
  const quoted = /^'((?:[^']|'')*)'(::[\w ."]+(\[\])?)?$/.exec(text);
  if (quoted) {
    const value = quoted[1].replace(/''/g, "'");
    if (udt === 'jsonb' || udt === 'json') return JSON.parse(value);
    if (udt.startsWith('_')) {
      if (value === '{}') return [];
      return value
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map((part) => part.replace(/^"|"$/g, ''));
    }
    if (udt === 'int8' || udt === 'numeric') return value;
    if (/^(int2|int4|float4|float8)$/.test(udt)) return Number(value);
    return value;
  }
  throw new Error(`unrecognized default literal: ${raw}`);
}

function parseDefault(raw: string | null, udt: string): Default | null {
  if (raw === null) return null;
  if (/^(now\(\)|CURRENT_TIMESTAMP)$/i.test(raw)) return { kind: 'now' };
  if (raw === 'gen_random_uuid()') return { kind: 'uuid' };
  if (raw.startsWith('nextval(')) return { kind: 'serial' };
  return { kind: 'value', value: parseLiteral(raw, udt) };
}

const ON_DELETE: Record<string, ForeignKey['onDelete']> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables: Record<string, Table> = {};

    const columns = await client.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable, c.column_default
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.column_name
    `);
    for (const row of columns.rows) {
      const table = (tables[row.table_name] ??= {
        columns: {},
        primaryKey: [],
        unique: [],
        foreignKeys: [],
      });
      table.columns[row.column_name] = {
        type: row.udt_name,
        nullable: row.is_nullable === 'YES',
        default: parseDefault(row.column_default, row.udt_name),
      };
    }

    // Primary keys, unique constraints and unique indexes (a partial unique
    // index is left out: memory cannot evaluate its predicate generically).
    const keys = await client.query<{
      table_name: string;
      is_primary: boolean;
      columns: string[];
    }>(`
      SELECT tc.relname AS table_name, i.indisprimary AS is_primary,
             array_agg(a.attname::text ORDER BY k.ord) AS columns
      FROM pg_index i
      JOIN pg_class tc ON tc.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace AND n.nspname = 'public'
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = k.attnum
      WHERE i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
      GROUP BY tc.relname, i.indexrelid, i.indisprimary
      ORDER BY tc.relname, i.indisprimary DESC, columns
    `);
    for (const row of keys.rows) {
      const table = tables[row.table_name];
      if (!table) continue;
      if (row.is_primary) table.primaryKey = row.columns;
      else table.unique.push(row.columns);
    }

    const foreignKeys = await client.query<{
      table_name: string;
      ref_table: string;
      columns: string[];
      ref_columns: string[];
      on_delete: string;
    }>(`
      SELECT tc.relname AS table_name, rc.relname AS ref_table, c.confdeltype AS on_delete,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS columns,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS ref_columns
      FROM pg_constraint c
      JOIN pg_class tc ON tc.oid = c.conrelid
      JOIN pg_class rc ON rc.oid = c.confrelid
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      ORDER BY tc.relname, c.conname
    `);
    for (const row of foreignKeys.rows) {
      tables[row.table_name]?.foreignKeys.push({
        columns: row.columns,
        refTable: row.ref_table,
        refColumns: row.ref_columns,
        onDelete: ON_DELETE[row.on_delete] ?? 'no action',
      });
    }

    const body = JSON.stringify(tables, null, 2);
    writeFileSync(
      OUT,
      `/**
 * GENERATED by scripts/generate-store-schema.ts from a migrated database —
 * do not edit. Regenerate after a migration: pnpm --filter @renkei/db db:store-schema
 */

import type { StoreSchema } from './memory/schema';

export const STORE_SCHEMA: StoreSchema = ${body};
`
    );
    console.log(`✓ Wrote ${Object.keys(tables).length} tables to ${OUT}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
