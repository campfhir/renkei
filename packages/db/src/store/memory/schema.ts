/** The shape of schema.generated.ts: what the memory tables need to know about each table. */

export type ColumnDefault =
  { kind: 'now' } | { kind: 'uuid' } | { kind: 'serial' } | { kind: 'value'; value: unknown };

export interface ColumnSchema {
  /** Postgres udt_name: text, varchar, uuid, int4, int8, timestamptz, jsonb, _text, … */
  type: string;
  nullable: boolean;
  default: ColumnDefault | null;
}

export interface ForeignKeySchema {
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
}

export interface TableSchema {
  columns: Record<string, ColumnSchema>;
  primaryKey: string[];
  unique: string[][];
  foreignKeys: ForeignKeySchema[];
}

export type StoreSchema = Record<string, TableSchema>;
