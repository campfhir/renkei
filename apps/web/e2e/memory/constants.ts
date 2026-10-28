/**
 * Shared by playwright.memory.config.ts and the memory specs. The seed
 * token is no secret: it only opens the sign-in route
 * (app/api/test/session) on a server running the in-memory store, which
 * holds nothing but what the suite staged.
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
 * connector and model API keys), fixed for the same reason: a dev server
 * whose environment changes rebuilds. A test key, for a store that holds
 * fixtures only.
 */
export const MEMORY_TOKEN_ENCRYPTION_KEY = 'cmVua2VpLWUyZS1tZW1vcnktdG9rZW4ta2V5LTMyYiE=';
/**
 * The stand-in model (e2e/llm-stub.mjs): an OpenAI-compatible base URL to
 * give a model on the admin roster, and the one reply it ever makes — an
 * agent run's finish_run summary, or a chat turn's text.
 */
/**
 * The sandbox stub (e2e/sandbox-stub.mjs), which also stands in for
 * Bitbucket and Jira administration. SANDBOX_STUB_PORT moves it, for a
 * checkout that runs its own copy beside another's.
 */
export const SANDBOX_STUB_PORT = Number(process.env.SANDBOX_STUB_PORT ?? 8092);
export const SANDBOX_STUB_URL = `http://127.0.0.1:${SANDBOX_STUB_PORT}`;
export const LLM_STUB_PORT = Number(process.env.E2E_LLM_STUB_PORT ?? 8094);
export const LLM_STUB_BASE_URL = `http://127.0.0.1:${LLM_STUB_PORT}/v1`;
export const LLM_STUB_REPLY = 'The stub model finished the work.';
/** What it says of a picture it is asked to digest. */
export const LLM_STUB_PICTURE = 'A picture the stub model looked at.';
