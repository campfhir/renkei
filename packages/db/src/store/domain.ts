import type { Kysely } from 'kysely';
import type { DB } from '../db.types';
import type { MemoryTables, TableRows } from './memory/tables';

/**
 * One area of the data store: its repository, built either over Postgres
 * (Kysely, resolved per call) or over the memory tables. Each lives in
 * domains/<name>/ with
 *
 *   types.ts      the repository interface and its record types
 *   postgres.ts   the Kysely implementation
 *   memory.ts     the same answers from MemoryTables
 *   scenarios.ts  differential scenarios: fixture + call, run against both
 *   index.ts      `defineDomain({ postgres, memory })`
 *
 * and is registered once in domains/index.ts.
 */
export interface Domain<R> {
  postgres(db: () => Kysely<DB>): R;
  memory(tables: MemoryTables): R;
}

export function defineDomain<R>(domain: Domain<R>): Domain<R> {
  return domain;
}

/**
 * One differential case: rows to start from and a call to make. The
 * harness (differential/harness.ts) seeds the same rows into a fresh
 * Postgres and a fresh memory store, runs `run` against each, and requires
 * the two answers to be equal. Whatever `run` returns is compared — return
 * the method's result, plus any reads that show what a write did.
 *
 * Determinism is the scenario's job: name ids and timestamps in the
 * fixture rather than leaving them to defaults, and leave out of the
 * answer anything a default generated (a fresh uuid, now()).
 */
export interface Scenario<S = unknown> {
  /** `<domain key>.<method>`, e.g. `notifications.list`: what the coverage test counts. */
  method: string;
  name: string;
  fixture?: TableRows;
  run(store: S): Promise<unknown>;
}
