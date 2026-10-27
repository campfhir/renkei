import type { Insertable, Selectable, Updateable } from 'kysely';
import type { DB } from '../../db.types';
import { STORE_SCHEMA } from '../schema.generated';
import type { ColumnSchema, StoreSchema, TableSchema } from './schema';
import { sameValue } from './order';

/**
 * The memory store's tables: rows shaped exactly as Postgres returns them
 * through pg and Kysely (snake_case columns, Dates for timestamps, strings
 * for int8 and numeric, parsed JSON), kept in arrays, one per table.
 *
 * Writes go through the generated schema (schema.generated.ts), so they
 * behave like the real table: defaults fill in (now(), gen_random_uuid(),
 * literals, sequences), a missing NOT NULL value, a duplicate primary or
 * unique key, a malformed uuid and a reference to a missing parent are
 * refused with Postgres's SQLSTATE on the error's `code`, and a delete
 * cascades, nulls or refuses along the foreign keys as declared. Reads
 * hand out copies.
 *
 * Domain repositories (../domains/*\/memory.ts) read and write through
 * this, and sort and filter with ./order.ts.
 */

export type TableName = keyof DB & string;
export type Row<T extends TableName> = Selectable<DB[T]>;
export type NewRow<T extends TableName> = Insertable<DB[T]>;
export type RowPatch<T extends TableName> = Updateable<DB[T]>;
/** Fixture rows by table, as a test or a seed hands them over. */
export type TableRows = { [T in TableName]?: NewRow<T>[] };

type Fields = Record<string, unknown>;

/** A refusal the way pg reports one: `code` is the SQLSTATE callers already check. */
export class MemoryStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly table?: string,
    readonly constraint?: string
  ) {
    super(message);
    this.name = 'MemoryStoreError';
  }
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** One value as pg would hand it back for a column of this type. */
function normalize(table: string, column: string, schema: ColumnSchema, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = schema.type;
  if (type.startsWith('_')) {
    if (!Array.isArray(value)) {
      throw new MemoryStoreError('22P02', `malformed array literal for ${table}.${column}`, table);
    }
    const element: ColumnSchema = { type: type.slice(1), nullable: true, default: null };
    return value.map((item) => normalize(table, column, element, item));
  }
  switch (type) {
    case 'timestamptz':
    case 'timestamp':
    case 'date': {
      const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        throw new MemoryStoreError('22007', `invalid timestamp for ${table}.${column}`, table);
      }
      if (type === 'date') date.setUTCHours(0, 0, 0, 0);
      return date;
    }
    case 'int8':
    case 'numeric':
      return String(value);
    case 'int2':
    case 'int4':
    case 'float4':
    case 'float8': {
      const number = Number(value);
      if (Number.isNaN(number)) {
        throw new MemoryStoreError('22P02', `invalid number for ${table}.${column}`, table);
      }
      return type.startsWith('int') ? Math.trunc(number) : number;
    }
    case 'bool':
      return Boolean(value);
    case 'json':
    case 'jsonb':
      // pg sends a string as text, which Postgres parses as JSON; an object
      // it JSON-encodes itself; an array it sends as a Postgres array
      // literal, which is not JSON — the same refusal here.
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          throw new MemoryStoreError(
            '22P02',
            `invalid input syntax for type json (${table}.${column})`,
            table
          );
        }
      }
      if (Array.isArray(value)) {
        throw new MemoryStoreError(
          '22P02',
          `invalid input syntax for type json (${table}.${column})`,
          table
        );
      }
      return JSON.parse(JSON.stringify(value));
    case 'uuid': {
      const text = String(value);
      if (!UUID.test(text)) {
        throw new MemoryStoreError('22P02', `invalid input syntax for type uuid: "${text}"`, table);
      }
      const hex = text.replace(/-/g, '').toLowerCase();
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case 'bytea':
      return Buffer.from(value instanceof Uint8Array ? value : String(value));
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/** A deep copy of one stored value. */
function copyValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  return structuredClone(value);
}

function copyRow(row: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(row)) out[key] = copyValue(value);
  return out;
}

export class MemoryTables {
  private readonly data = new Map<string, Fields[]>();
  private readonly serials = new Map<string, number>();
  /** For each table, the foreign keys elsewhere that point at it. */
  private readonly referencedBy = new Map<
    string,
    { table: string; fk: TableSchema['foreignKeys'][number] }[]
  >();

  constructor(private readonly schema: StoreSchema = STORE_SCHEMA) {
    for (const [table, def] of Object.entries(schema)) {
      for (const fk of def.foreignKeys) {
        const list = this.referencedBy.get(fk.refTable) ?? [];
        list.push({ table, fk });
        this.referencedBy.set(fk.refTable, list);
      }
    }
  }

  private def(table: string): TableSchema {
    const def = this.schema[table];
    if (!def) throw new MemoryStoreError('42P01', `relation "${table}" does not exist`, table);
    return def;
  }

  private rows(table: string): Fields[] {
    let rows = this.data.get(table);
    if (!rows) {
      this.def(table);
      rows = [];
      this.data.set(table, rows);
    }
    return rows;
  }

  // The one place rows cross from untyped storage to the generated row
  // types: every stored row was built column by column from the schema
  // that also generated those types.
  private typed<T>(row: Fields): T {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return row as T;
  }

  /**
   * A query parameter as Postgres would read it for this column: a uuid
   * lower-cased (or refused as malformed, 22P02), a timestamp as a Date,
   * an int8 as its string. Compare row values against this, not against
   * the caller's raw input, wherever the input comes from outside —
   * `WHERE id = $1` with a malformed id is an error in Postgres, not an
   * empty result.
   */
  param<T extends TableName>(table: T, column: keyof Row<T> & string, value: unknown): unknown {
    const schema = this.def(table).columns[column];
    if (!schema) {
      throw new MemoryStoreError(
        '42703',
        `column "${column}" of relation "${table}" does not exist`,
        table
      );
    }
    return normalize(table, column, schema, value);
  }

  /** Every row of a table, or those matching `where`, as copies. */
  select<T extends TableName>(table: T, where?: (row: Row<T>) => boolean): Row<T>[] {
    const out: Row<T>[] = [];
    for (const row of this.rows(table)) {
      const typed = this.typed<Row<T>>(row);
      if (!where || where(typed)) out.push(this.typed<Row<T>>(copyRow(row)));
    }
    return out;
  }

  /** The first matching row, or undefined (as executeTakeFirst). */
  first<T extends TableName>(table: T, where: (row: Row<T>) => boolean): Row<T> | undefined {
    return this.select(table, where)[0];
  }

  /** Build a complete row from `values` and the column defaults, without storing it. */
  private build(table: string, values: Fields, now: Date): Fields {
    const def = this.def(table);
    for (const key of Object.keys(values)) {
      if (!(key in def.columns) && values[key] !== undefined) {
        throw new MemoryStoreError(
          '42703',
          `column "${key}" of relation "${table}" does not exist`,
          table
        );
      }
    }
    const row: Fields = {};
    for (const [column, schema] of Object.entries(def.columns)) {
      let value = values[column];
      if (value === undefined && schema.default) {
        const d = schema.default;
        if (d.kind === 'now') value = new Date(now.getTime());
        else if (d.kind === 'uuid') value = globalThis.crypto.randomUUID();
        else if (d.kind === 'serial') {
          const key = `${table}.${column}`;
          const next = (this.serials.get(key) ?? 0) + 1;
          this.serials.set(key, next);
          value = next;
        } else if (schema.type === 'json' || schema.type === 'jsonb') {
          // A literal default is a JSON value Postgres already holds, an
          // array included — not a JS array pg would send as an array literal.
          value = JSON.stringify(d.value);
        } else value = copyValue(d.value);
      }
      row[column] = normalize(table, column, schema, value);
    }
    this.checkNotNull(table, def, row);
    return row;
  }

  private checkNotNull(table: string, def: TableSchema, row: Fields): void {
    for (const [column, schema] of Object.entries(def.columns)) {
      if (!schema.nullable && (row[column] === null || row[column] === undefined)) {
        throw new MemoryStoreError(
          '23502',
          `null value in column "${column}" of relation "${table}" violates not-null constraint`,
          table
        );
      }
    }
  }

  private keysOf(def: TableSchema): string[][] {
    return def.primaryKey.length > 0 ? [def.primaryKey, ...def.unique] : def.unique;
  }

  /** The stored row `row` collides with on a key, if any (`except` is the row being updated). */
  private conflict(
    table: string,
    row: Fields,
    columns: string[],
    except?: Fields
  ): Fields | undefined {
    if (columns.some((c) => row[c] === null || row[c] === undefined)) return undefined;
    return this.rows(table).find(
      (other) => other !== except && columns.every((c) => sameValue(other[c], row[c]))
    );
  }

  private checkKeys(table: string, def: TableSchema, row: Fields, except?: Fields): void {
    for (const columns of this.keysOf(def)) {
      if (this.conflict(table, row, columns, except)) {
        throw new MemoryStoreError(
          '23505',
          `duplicate key value violates unique constraint on ${table} (${columns.join(', ')})`,
          table,
          `${table}_${columns.join('_')}`
        );
      }
    }
  }

  private checkReferences(table: string, def: TableSchema, row: Fields): void {
    for (const fk of def.foreignKeys) {
      const values = fk.columns.map((c) => row[c]);
      if (values.some((v) => v === null || v === undefined)) continue;
      const parent = this.rows(fk.refTable).find((candidate) =>
        fk.refColumns.every((c, i) => sameValue(candidate[c], values[i]))
      );
      if (!parent) {
        throw new MemoryStoreError(
          '23503',
          `insert or update on table "${table}" violates foreign key to "${fk.refTable}"`,
          table
        );
      }
    }
  }

  /** INSERT … RETURNING *. */
  insert<T extends TableName>(table: T, values: NewRow<T>): Row<T> {
    const def = this.def(table);
    const row = this.build(table, { ...values }, new Date());
    this.checkKeys(table, def, row);
    this.checkReferences(table, def, row);
    this.rows(table).push(row);
    return this.typed<Row<T>>(copyRow(row));
  }

  /** Several rows, one statement: all go in or none do. */
  insertMany<T extends TableName>(table: T, values: NewRow<T>[]): Row<T>[] {
    const before = this.rows(table).length;
    try {
      return values.map((value) => this.insert(table, value));
    } catch (error) {
      this.rows(table).splice(before);
      throw error;
    }
  }

  /**
   * INSERT … ON CONFLICT (columns) DO UPDATE SET patch — `patch` may be a
   * function of the existing row (EXCLUDED is `values`). Without a patch,
   * DO NOTHING: returns undefined when the row already existed.
   */
  upsert<T extends TableName>(
    table: T,
    values: NewRow<T>,
    conflictColumns: (keyof Row<T> & string)[],
    patch?: RowPatch<T> | ((existing: Row<T>) => RowPatch<T>)
  ): Row<T> | undefined {
    const def = this.def(table);
    const candidate = this.build(table, { ...values }, new Date());
    const existing = this.conflict(table, candidate, conflictColumns);
    if (!existing) return this.insert(table, values);
    if (!patch) return undefined;
    const changes =
      typeof patch === 'function' ? patch(this.typed<Row<T>>(copyRow(existing))) : patch;
    return this.patchRow(table, def, existing, { ...changes });
  }

  private patchRow<T extends TableName>(
    table: T,
    def: TableSchema,
    row: Fields,
    changes: Fields
  ): Row<T> {
    const next: Fields = { ...row };
    for (const [column, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      const schema = def.columns[column];
      if (!schema) {
        throw new MemoryStoreError(
          '42703',
          `column "${column}" of relation "${table}" does not exist`,
          table
        );
      }
      next[column] = normalize(table, column, schema, value);
    }
    this.checkNotNull(table, def, next);
    this.checkKeys(table, def, next, row);
    this.checkReferences(table, def, next);
    Object.assign(row, next);
    return this.typed<Row<T>>(copyRow(row));
  }

  /** UPDATE … SET patch WHERE … RETURNING *; `patch` may depend on the row. */
  update<T extends TableName>(
    table: T,
    where: (row: Row<T>) => boolean,
    patch: RowPatch<T> | ((row: Row<T>) => RowPatch<T>)
  ): Row<T>[] {
    const def = this.def(table);
    const targets = this.rows(table).filter((row) => where(this.typed<Row<T>>(row)));
    return targets.map((row) => {
      const changes = typeof patch === 'function' ? patch(this.typed<Row<T>>(copyRow(row))) : patch;
      return this.patchRow(table, def, row, { ...changes });
    });
  }

  /** DELETE … WHERE … RETURNING *, following every foreign key that points here. */
  delete<T extends TableName>(table: T, where: (row: Row<T>) => boolean): Row<T>[] {
    const doomed = this.rows(table).filter((row) => where(this.typed<Row<T>>(row)));
    const deleted = doomed.map((row) => this.typed<Row<T>>(copyRow(row)));
    this.deleteRows(table, new Set(doomed));
    return deleted;
  }

  /** DELETE on a table named at runtime (resetting a subject's rows across every table). */
  deleteWhere(table: string, where: (row: Readonly<Fields>) => boolean): number {
    const doomed = new Set(this.rows(table).filter(where));
    this.deleteRows(table, doomed);
    return doomed.size;
  }

  private deleteRows(table: string, doomed: Set<Fields>): void {
    if (doomed.size === 0) return;
    this.data.set(
      table,
      this.rows(table).filter((row) => !doomed.has(row))
    );
    for (const { table: child, fk } of this.referencedBy.get(table) ?? []) {
      const pointsAtDoomed = (row: Fields) =>
        [...doomed].some((parent) =>
          fk.refColumns.every((c, i) => sameValue(parent[c], row[fk.columns[i]]))
        );
      const children = this.rows(child).filter(pointsAtDoomed);
      if (children.length === 0) continue;
      if (fk.onDelete === 'cascade') {
        this.deleteRows(child, new Set(children));
      } else if (fk.onDelete === 'set null' || fk.onDelete === 'set default') {
        const childDef = this.def(child);
        for (const row of children) {
          for (const column of fk.columns) {
            const d = childDef.columns[column]?.default;
            row[column] =
              fk.onDelete === 'set default' && d?.kind === 'value' ? copyValue(d.value) : null;
          }
        }
      } else {
        // Put the parents back: the statement fails whole.
        this.rows(table).push(...doomed);
        throw new MemoryStoreError(
          '23503',
          `update or delete on table "${table}" violates foreign key from "${child}"`,
          child
        );
      }
    }
  }

  /**
   * Load fixtures, parents before children (foreign-key order). With
   * `replace`, a row whose primary key is already stored replaces it (the
   * old row is deleted first, cascades and all) — for fixtures of
   * org-wide rows that a long-lived test server already holds.
   */
  seed(fixtures: TableRows, options: { replace?: boolean } = {}): void {
    for (const table of this.insertionOrder(Object.keys(fixtures))) {
      const rows: unknown = Reflect.get(fixtures, table);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) {
          throw new MemoryStoreError('22P02', `fixture rows for ${table} must be objects`, table);
        }
        const def = this.def(table);
        const built = this.build(table, { ...row }, new Date());
        if (options.replace && def.primaryKey.length > 0) {
          const existing = this.conflict(table, built, def.primaryKey);
          if (existing) this.deleteRows(table, new Set([existing]));
        }
        this.checkKeys(table, def, built);
        this.checkReferences(table, def, built);
        this.rows(table).push(built);
      }
    }
  }

  /** Tables ordered so every parent comes before the tables that reference it. */
  insertionOrder(tables: string[]): string[] {
    const wanted = new Set(tables);
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const visit = (table: string) => {
      if (ordered.includes(table) || visiting.has(table)) return;
      visiting.add(table);
      for (const fk of this.def(table).foreignKeys) {
        if (wanted.has(fk.refTable) && fk.refTable !== table) visit(fk.refTable);
      }
      visiting.delete(table);
      ordered.push(table);
    };
    for (const table of tables) visit(table);
    return ordered;
  }

  /** Forget every row (and restart the sequences). */
  clear(): void {
    this.data.clear();
    this.serials.clear();
  }

  /** The table names this schema knows. */
  tableNames(): string[] {
    return Object.keys(this.schema);
  }

  /** The column schema of a table (for seeding Postgres with the same values). */
  columnsOf(table: string): Record<string, ColumnSchema> {
    return this.def(table).columns;
  }
}
