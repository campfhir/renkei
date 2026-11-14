/**
 * A sandbox's first step, before anything else of the worker is loaded.
 *
 * A sandbox the orchestrator made for one scope is created with almost
 * nothing: its own bearer key, its id, and where the orchestrator is
 * (docs/sandbox-orchestrator-design.md). No database URL — a sandbox has
 * no database access — and no other secret: nothing a process listing,
 * the platform's own tooling or a scanner on the network could read.
 *
 * So, here:
 *
 *  1. The rest of what the worker is started with (its key for the
 *     delegate, the key its workspace secrets are sealed with) is asked
 *     of the orchestrator and comes back SEALED under this sandbox's own
 *     key (@renkei/connector-sandbox sealed-env.ts). It is opened in
 *     this process and put in its environment — root's, which no
 *     caller's command can read — before the modules that read the
 *     environment are loaded.
 *  2. The data store is registered as a REMOTE one (@renkei/db
 *     store/remote.ts): every repository call the worker makes goes to
 *     the orchestrator, which runs the ones a sandbox may make. Any
 *     DATABASE_URL that somehow reached this process is dropped.
 *
 * A worker many callers share (not orchestrated) does neither: it has
 * its environment and its database role as it always did.
 */

import { openSandboxEnv } from '@renkei/connector-sandbox';
import { createHttpStoreTransport, createRemoteDataStore, registerDataStore } from '@renkei/db';

/**
 * `value` without its trailing slashes. A loop, not `/\/+$/`: on a long
 * run of slashes that does not end the string, that expression backtracks
 * over it again and again, and these values come from outside.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

const ATTEMPTS = 20;
const RETRY_MS = 1_500;

export interface SealedBootDeps {
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  register?: typeof registerDataStore;
}

/**
 * Do the two steps above when this is an orchestrated sandbox. Answers
 * what it did; throws, with why, when an orchestrated sandbox cannot be
 * brought up this way — it must not start half-configured.
 */
export async function sealedBoot(deps: SealedBootDeps): Promise<'shared' | 'sandbox'> {
  const { env } = deps;
  if (env.SANDBOX_ORCHESTRATED !== '1') return 'shared';
  const url = withoutTrailingSlashes(env.SANDBOX_ORCHESTRATOR_CALLBACK_URL?.trim() ?? '');
  const sandboxId = env.SANDBOX_INSTANCE_ID?.trim();
  const sandboxKey = env.SANDBOX_WORKER_API_KEY?.trim();
  if (!url || !sandboxId || !sandboxKey) {
    throw new Error(
      'this sandbox was made without its id, its key or the orchestrator’s address (SANDBOX_INSTANCE_ID, SANDBOX_WORKER_API_KEY, SANDBOX_ORCHESTRATOR_CALLBACK_URL)'
    );
  }
  const request = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let sealed: string | null = null;
  let last = 'no answer';
  // The orchestrator may be a moment behind the sandbox it just made.
  for (let attempt = 0; attempt < ATTEMPTS && sealed === null; attempt += 1) {
    try {
      const response = await request(`${url}/sandbox/v1/bootstrap`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sandboxKey}`, 'x-sandbox-id': sandboxId },
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await response.json().catch(() => null);
      if (
        response.ok &&
        typeof body === 'object' &&
        body !== null &&
        'sealed' in body &&
        typeof body.sealed === 'string'
      ) {
        sealed = body.sealed;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (sealed === null) await sleep(RETRY_MS);
  }
  if (sealed === null) {
    throw new Error(
      `the orchestrator at ${url} did not hand this sandbox its environment: ${last}`
    );
  }
  const opened = openSandboxEnv(sandboxKey, sandboxId, sealed);
  if (!opened) {
    throw new Error(
      'the environment the orchestrator answered was not sealed for this sandbox, or was changed on the way'
    );
  }
  for (const [name, value] of Object.entries(opened)) {
    // What the sandbox was created with is never replaced by what it is handed.
    if (env[name] === undefined) env[name] = value;
  }
  // A sandbox has no database: whatever named one is not kept.
  delete env.DATABASE_URL;
  (deps.register ?? registerDataStore)(
    createRemoteDataStore(createHttpStoreTransport({ url, sandboxId, sandboxKey }))
  );
  return 'sandbox';
}
