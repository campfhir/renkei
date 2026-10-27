/**
 * The data-store contract against the in-memory store. Needs nothing, so
 * it runs everywhere `pnpm test` does.
 */

import { describeDataStoreContract } from './contract';
import { createMemoryDataStore } from './memory';

describeDataStoreContract('memory', async () => ({
  store: createMemoryDataStore(),
  cleanup: async () => {},
}));
