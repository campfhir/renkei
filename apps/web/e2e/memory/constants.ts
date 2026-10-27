/**
 * Shared by playwright.memory.config.ts and the memory specs. The seed
 * token is no secret: it only opens app/api/test/data-store on a server
 * running the in-memory store, which holds nothing but fixtures.
 */
/** E2E_MEMORY_PORT moves it, so several checkouts can each run a server. */
export const MEMORY_PORT = Number(process.env.E2E_MEMORY_PORT ?? 3100);
export const MEMORY_BASE_URL = `http://127.0.0.1:${MEMORY_PORT}`;
export const MEMORY_SEED_TOKEN = 'e2e-memory-seed-token';
