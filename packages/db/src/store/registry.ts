import { getDatabase } from '../client';
import { createMemoryDataStore, type MemoryDataStore } from './memory';
import { createPostgresDataStore } from './postgres';
import { memoryDataStoreRequested } from './selection';
import type { DataStore } from './types';

/**
 * Which data store this process uses. Postgres unless something registered
 * another — apps/web's instrumentation.ts registers the memory store when
 * RENKEI_DATA_STORE=memory, and tests register whatever they need.
 *
 * Anchored on globalThis for the same reason client.ts's pool is: Next
 * evaluates this module once per compilation graph (instrumentation, the
 * routes, the pages), and the store instrumentation registered has to be
 * the one every page reads — the memory store most of all, since its rows
 * live in the instance.
 */
interface StoreState {
  store: DataStore | null;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForStore = globalThis as unknown as { __renkeiDataStoreState?: StoreState };
const state: StoreState = (globalForStore.__renkeiDataStoreState ??= { store: null });

export function registerDataStore(store: DataStore): void {
  state.store = store;
}

export function getDataStore(): DataStore {
  if (state.store) return state.store;
  state.store = memoryDataStoreRequested()
    ? createMemoryDataStore()
    : createPostgresDataStore(() => {
        const db = getDatabase();
        // Rejects the call that needed it, as a failed query would.
        if (!db.ok) throw new Error(db.err.type);
        return db.val;
      });
  return state.store;
}

/** The registered store when it is the memory one (fixtures, the test seed route); else null. */
export function getMemoryDataStore(): MemoryDataStore | null {
  const store = getDataStore();
  return isMemoryDataStore(store) ? store : null;
}

function isMemoryDataStore(store: DataStore): store is MemoryDataStore {
  return store.kind === 'memory' && 'seed' in store && 'reset' in store;
}

/** Test hook: forget the registered store, so the next read builds the default again. */
export function resetDataStore(): void {
  state.store = null;
}
