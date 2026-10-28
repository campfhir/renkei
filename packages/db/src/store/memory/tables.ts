import type { Selectable } from 'kysely';
import type { DB, JsonValue } from '../../db.types';

/**
 * The memory store's tables: a mock, not a database. Each table is an
 * array of rows, shaped as the domain's Postgres side reads them back
 * (snake_case columns, Dates for timestamps, strings for int8 and numeric,
 * parsed JSON). Rows go in whole and come back as copies, filtered by a
 * predicate; that is all.
 *
 * Nothing here knows a table's columns, keys or references. A domain's
 * memory.ts fills the fields its records show (ids, timestamps, status
 * defaults) where it inserts, refuses a duplicate only where a caller
 * turns that refusal into behaviour, and removes the dependent rows a
 * delete visibly takes with it, in a few explicit lines. Sorting and
 * matching helpers are in ./order.ts.
 */

export type TableName = keyof DB & string;
export type Row<T extends TableName> = Selectable<DB[T]>;
/** A fixture row: whichever columns the test reads back. */
export type NewRow<T extends TableName> = Partial<Row<T>>;
export type RowPatch<T extends TableName> = Partial<Row<T>>;
/** Fixture rows by table, as a test or a seed hands them over. */
export type TableRows = { [T in TableName]?: NewRow<T>[] };

type Fields = Record<string, unknown>;

/**
 * A refusal a caller acts on, shaped like pg's: `code` is the SQLSTATE the
 * caller checks (23505 for a duplicate), `constraint` the name it may match.
 */
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

/** The duplicate refusal (23505) a domain raises where a caller depends on it. */
export function uniqueViolation(table: string, constraint: string): MemoryStoreError {
  return new MemoryStoreError(
    '23505',
    `duplicate key value violates unique constraint "${constraint}"`,
    table,
    constraint
  );
}

/** A JSON column's value as Postgres hands it back: the value's JSON round trip. */
export function toJson(value: unknown): JsonValue {
  const text = JSON.stringify(value ?? null);
  return parseJson(text);
}

/** A JSON column's value from JSON text (what a shared record helper writes for Postgres). */
export function parseJson(text: string): JsonValue;
export function parseJson(text: string | null): JsonValue | null;
export function parseJson(text: string | null): JsonValue | null {
  if (text === null) return null;
  const value: JsonValue = JSON.parse(text);
  return value;
}

function copyValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  return structuredClone(value);
}

function copyRow(row: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = copyValue(value);
  }
  return out;
}

export class MemoryTables {
  private readonly data = new Map<string, Fields[]>();

  private rows(table: string): Fields[] {
    let rows = this.data.get(table);
    if (!rows) {
      rows = [];
      this.data.set(table, rows);
    }
    return rows;
  }

  // Rows cross from untyped storage to the row types here: what went in
  // was a Row<T> (or a fixture's part of one).
  private typed<T>(row: Fields): T {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return row as T;
  }

  /** Every row of a table, or those matching `where`, as copies. */
  select<T extends TableName>(table: T, where?: (row: Row<T>) => boolean): Row<T>[] {
    const out: Row<T>[] = [];
    for (const row of this.rows(table)) {
      if (!where || where(this.typed<Row<T>>(row))) out.push(this.typed<Row<T>>(copyRow(row)));
    }
    return out;
  }

  /** The first matching row, or undefined. */
  first<T extends TableName>(table: T, where: (row: Row<T>) => boolean): Row<T> | undefined {
    return this.select(table, where)[0];
  }

  /** Store a whole row; returns a copy. */
  insert<T extends TableName>(table: T, row: Row<T>): Row<T> {
    const stored = copyRow({ ...row });
    this.rows(table).push(stored);
    return this.typed<Row<T>>(copyRow(stored));
  }

  /**
   * Insert `row`, or, when a stored row matches it on `keys`, patch that
   * one instead (`patch` may be a function of it). Without a patch the
   * stored row is left alone and undefined comes back.
   */
  upsert<T extends TableName>(
    table: T,
    row: Row<T>,
    keys: (keyof Row<T> & string)[],
    patch?: RowPatch<T> | ((existing: Row<T>) => RowPatch<T>)
  ): Row<T> | undefined {
    const values: Fields = row;
    const existing = this.rows(table).find((other) =>
      keys.every((key) => sameKey(other[key], values[key]))
    );
    if (!existing) return this.insert(table, row);
    if (!patch) return undefined;
    const changes =
      typeof patch === 'function' ? patch(this.typed<Row<T>>(copyRow(existing))) : patch;
    Object.assign(existing, copyRow(changes));
    return this.typed<Row<T>>(copyRow(existing));
  }

  /** Patch every matching row (`patch` may depend on the row); returns copies. */
  update<T extends TableName>(
    table: T,
    where: (row: Row<T>) => boolean,
    patch: RowPatch<T> | ((row: Row<T>) => RowPatch<T>)
  ): Row<T>[] {
    const targets = this.rows(table).filter((row) => where(this.typed<Row<T>>(row)));
    return targets.map((row) => {
      const changes = typeof patch === 'function' ? patch(this.typed<Row<T>>(copyRow(row))) : patch;
      Object.assign(row, copyRow(changes));
      return this.typed<Row<T>>(copyRow(row));
    });
  }

  /** Remove every matching row; returns copies of them. */
  delete<T extends TableName>(table: T, where: (row: Row<T>) => boolean): Row<T>[] {
    const all = this.rows(table);
    const deleted: Row<T>[] = [];
    const kept: Fields[] = [];
    for (const row of all) {
      if (where(this.typed<Row<T>>(row))) deleted.push(this.typed<Row<T>>(copyRow(row)));
      else kept.push(row);
    }
    if (deleted.length > 0) this.data.set(table, kept);
    return deleted;
  }

  /** SELECT on a table named at runtime. Copies. */
  selectWhere(table: string, where: (row: Readonly<Fields>) => boolean): Fields[] {
    return this.rows(table)
      .filter(where)
      .map((row) => copyRow(row));
  }

  /** UPDATE on a table named at runtime; returns how many rows changed. */
  updateWhere(
    table: string,
    where: (row: Readonly<Fields>) => boolean,
    changes: Readonly<Fields>
  ): number {
    const targets = this.rows(table).filter(where);
    for (const row of targets) Object.assign(row, copyRow(changes));
    return targets.length;
  }

  /** DELETE on a table named at runtime; returns how many rows went. */
  deleteWhere(table: string, where: (row: Readonly<Fields>) => boolean): number {
    const all = this.rows(table);
    const kept = all.filter((row) => !where(row));
    this.data.set(table, kept);
    return all.length - kept.length;
  }

  /** The next value of an integer id column: one past the largest stored. */
  nextSerial<T extends TableName>(table: T, column: keyof Row<T> & string): number {
    let max = 0;
    for (const row of this.rows(table)) {
      const value = Number(row[column]);
      if (Number.isFinite(value) && value > max) max = value;
    }
    return max + 1;
  }

  /** Add fixture rows as given. */
  seed(fixtures: TableRows): void {
    for (const [table, rows] of Object.entries(fixtures)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) this.rows(table).push(copyRow({ ...row }));
    }
  }

  /** Forget every row. */
  clear(): void {
    this.data.clear();
  }

  /** The tables that have held rows. */
  tableNames(): string[] {
    return [...this.data.keys()];
  }
}

function sameKey(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}
