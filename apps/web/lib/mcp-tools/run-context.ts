/**
 * Which agent RUN the current tool call belongs to — the attempt-context
 * arrangement (attempt-context.ts) for one more value a cached, shared
 * tool handler cannot close over: the run id changes with every run of
 * the same agent, so it rides a request header and AsyncLocalStorage, and
 * is read only where a record needs it (the PHI access trail).
 *
 * Advisory, like the attempt: a caller that forges the header gains
 * nothing — the trail already names the subject and agent from the token,
 * and the run id only says which of that agent's runs — but it is still
 * taken only from an agent token's call (`recordPhiAccess` checks), never
 * from a person's own client.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ runId: string }>();

/** The header the agent runner stamps on each tool call. */
export const RUN_HEADER = 'x-renkei-run';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run id off request headers, when it is one; undefined otherwise. */
export function runIdFromHeaders(headers: Headers): string | undefined {
  const value = headers.get(RUN_HEADER)?.trim();
  return value && UUID_RE.test(value) ? value.toLowerCase() : undefined;
}

/** Run `work` with `runId` visible to `currentRunId()` throughout. */
export function withRun<T>(runId: string | undefined, work: () => T): T {
  return runId ? storage.run({ runId }, work) : work();
}

/** The run this tool call belongs to, or undefined for a person's own call. */
export function currentRunId(): string | undefined {
  return storage.getStore()?.runId;
}
