import { DOMAINS } from '../domains';
import type { DataStore } from '../types';
import type { QueueTable } from '../domains/queues/types';
import { queueSignal, type QueueSignal } from './signals';
import { MemoryTables, type TableRows } from './tables';

/**
 * The data store in plain JavaScript: every domain's memory repository
 * over one set of MemoryTables in this process — nothing on disk, nothing
 * shared with any other process.
 */
export interface MemoryDataStore extends DataStore {
  readonly kind: 'memory';
  readonly tables: MemoryTables;
  /**
   * Add fixture rows, by table (parents before children is handled);
   * `replace` overwrites rows whose primary key is already stored.
   */
  seed(fixtures: TableRows, options?: { replace?: boolean }): Promise<void>;
  /**
   * Forget everything, or only what one subject owns: rows of every table
   * whose `subject` or `owner_subject` is theirs, and what cascades from
   * those.
   */
  reset(subject?: string): void;
  /**
   * The in-process notify of one queue table (./signals.ts): what a
   * consumer running in this process waits on instead of a poll interval.
   */
  queueSignal(table: QueueTable): QueueSignal;
}

/** Fixture rows by table — the memory store's seed, and the differential suite's. */
export type MemorySeed = TableRows;

const OWNER_COLUMNS = ['subject', 'owner_subject'];

export function createMemoryDataStore(tables: MemoryTables = new MemoryTables()): MemoryDataStore {
  const repositories = Object.fromEntries(
    Object.entries(DOMAINS).map(([key, domain]) => [key, domain.memory(tables)])
  );
  const store = {
    ...repositories,
    kind: 'memory' as const,
    tables,
    async seed(fixtures: TableRows, options: { replace?: boolean } = {}) {
      tables.seed(fixtures, options);
    },
    queueSignal(table: QueueTable) {
      return queueSignal(tables, table);
    },
    reset(subject?: string) {
      if (subject === undefined) {
        tables.clear();
        return;
      }
      for (const table of tables.tableNames()) {
        const columns = Object.keys(tables.columnsOf(table)).filter((c) =>
          OWNER_COLUMNS.includes(c)
        );
        if (columns.length === 0) continue;
        tables.deleteWhere(table, (row) => columns.some((c) => row[c] === subject));
      }
    },
  };
  return assemble(store);
}

// The repositories were built from DOMAINS key by key, which is exactly
// the DataStore type's definition; Object.fromEntries loses that.
function assemble<T>(store: T): MemoryDataStore {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return store as unknown as MemoryDataStore;
}
