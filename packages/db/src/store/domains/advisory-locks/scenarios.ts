import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

export const advisoryLockScenarios: Scenario<DataStore>[] = [
  {
    method: 'advisoryLocks.withTryLock',
    name: 'held while running: the same name skips, another name runs; free again after',
    run: async (store) => {
      const ran: string[] = [];
      const outer = await store.advisoryLocks.withTryLock('ns', 'sweep-a', async () => {
        ran.push('outer');
        const same = await store.advisoryLocks.withTryLock('ns', 'sweep-a', async () => {
          ran.push('same');
        });
        const other = await store.advisoryLocks.withTryLock('ns', 'sweep-b', async () => {
          ran.push('other');
        });
        const otherNamespace = await store.advisoryLocks.withTryLock('ns2', 'sweep-a', async () => {
          ran.push('other namespace');
        });
        ran.push(`same:${same} other:${other} ns2:${otherNamespace}`);
      });
      const again = await store.advisoryLocks.withTryLock('ns', 'sweep-a', async () => {
        ran.push('again');
      });
      return { outer, again, ran };
    },
  },
  {
    method: 'advisoryLocks.withTryLock',
    name: 'a throw is passed on and the lock still released',
    run: async (store) => {
      const thrown = await store.advisoryLocks
        .withTryLock('ns', 'sweep-c', async () => {
          throw new Error('provider exploded');
        })
        .then(
          () => 'resolved',
          (error: Error) => error.message
        );
      const after = await store.advisoryLocks.withTryLock('ns', 'sweep-c', async () => undefined);
      return { thrown, after };
    },
  },
];
