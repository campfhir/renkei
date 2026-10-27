/** The RENKEI_DATA_STORE value that selects the in-memory store. */
export const MEMORY_DATA_STORE = 'memory';

/**
 * Whether this process was configured for the memory store. Read by
 * client.ts as well as the registry, so that code not yet behind the seam
 * fails closed rather than reaching a real database a developer's env
 * happens to name. Its own module so client.ts need not import the
 * registry, which imports client.ts.
 */
export function memoryDataStoreRequested(): boolean {
  return process.env.RENKEI_DATA_STORE === MEMORY_DATA_STORE;
}
