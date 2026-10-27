import type { MemoryTables } from '../../memory/tables';
import type { AdvisoryLockStore } from './types';

/** The held locks live in this process only: one runner per process, not per deployment. */
export function memoryAdvisoryLocks(_tables: MemoryTables): AdvisoryLockStore {
  const held = new Set<string>();
  return {
    async withTryLock(namespace, name, fn) {
      const key = JSON.stringify([namespace, name]);
      if (held.has(key)) return false;
      held.add(key);
      try {
        await fn();
      } finally {
        held.delete(key);
      }
      return true;
    },
  };
}
