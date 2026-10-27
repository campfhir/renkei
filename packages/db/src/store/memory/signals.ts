import type { MemoryTables } from './tables';

/**
 * The memory store's in-process notify for its queues: Postgres consumers
 * poll, but on the memory store the producer and the consumer share one
 * process, so a consumer that found nothing can wait on this instead of a
 * poll interval and wake as soon as a message is enqueued.
 *
 * `version` counts the wakes so far. A consumer reads it before it claims
 * and waits with that number: a message enqueued between the empty claim
 * and the wait has already moved it on, and the wait returns at once.
 */
export interface QueueSignal {
  /** How many times the queue has been woken; read before claiming. */
  readonly version: number;
  /** Resolve once the version passes `since`, or after `timeoutMs`, whichever is first. */
  wait(since: number, timeoutMs: number): Promise<void>;
}

interface SignalState {
  version: number;
  waiters: Set<() => void>;
}

const SIGNALS = new WeakMap<MemoryTables, Map<string, SignalState>>();

function stateOf(tables: MemoryTables, table: string): SignalState {
  let byTable = SIGNALS.get(tables);
  if (!byTable) {
    byTable = new Map();
    SIGNALS.set(tables, byTable);
  }
  let state = byTable.get(table);
  if (!state) {
    state = { version: 0, waiters: new Set() };
    byTable.set(table, state);
  }
  return state;
}

/** Wake everyone waiting on `table` of these tables: something became claimable. */
export function wakeQueue(tables: MemoryTables, table: string): void {
  const state = stateOf(tables, table);
  state.version += 1;
  const waiters = [...state.waiters];
  state.waiters.clear();
  for (const wake of waiters) wake();
}

export function queueSignal(tables: MemoryTables, table: string): QueueSignal {
  const state = stateOf(tables, table);
  return {
    get version() {
      return state.version;
    },
    wait(since, timeoutMs) {
      if (state.version !== since) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          state.waiters.delete(wake);
          resolve();
        }, timeoutMs);
        state.waiters.add(wake);
      });
    },
  };
}
