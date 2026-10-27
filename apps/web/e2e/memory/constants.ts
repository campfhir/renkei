/**
 * Shared by playwright.memory.config.ts and the memory specs. The seed
 * token is no secret: it only opens app/api/test/data-store on a server
 * running the in-memory store, which holds nothing but fixtures.
 */
/** E2E_MEMORY_PORT moves it, so several checkouts can each run a server. */
export const MEMORY_PORT = Number(process.env.E2E_MEMORY_PORT ?? 3100);
export const MEMORY_BASE_URL = `http://127.0.0.1:${MEMORY_PORT}`;
export const MEMORY_SEED_TOKEN = 'e2e-memory-seed-token';
/**
 * Where the memory server's in-process delegate listens (lib/memory-delegate.ts),
 * and the key the app presents to it: named up front, so the dev server's
 * environment never changes under it.
 */
export const MEMORY_DELEGATE_URL = `http://127.0.0.1:${MEMORY_PORT + 1}`;
export const MEMORY_DELEGATE_API_KEY = 'e2e-memory-delegate-key';
/**
 * TOKEN_ENCRYPTION_KEY of the memory server (the org-wide secrets key:
 * connector and model API keys), fixed so a spec can seal a secret the way
 * the admin forms do (e2e/support/secrets.ts) and a reused dev server
 * still opens it. A test key, for a store that holds fixtures only.
 */
export const MEMORY_TOKEN_ENCRYPTION_KEY = 'cmVua2VpLWUyZS1tZW1vcnktdG9rZW4ta2V5LTMyYiE=';
