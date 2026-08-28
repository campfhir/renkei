/**
 * Which try of an agent step the CURRENT tool call belongs to.
 *
 * ## Why this cannot live on MCPToolContext
 *
 * Tool handlers close over one `MCPToolContext` built when the handler was
 * registered, and handlers are CACHED and shared — the cache key covers the
 * caller, their scopes and the agent id, all of which are fixed for the life
 * of a token. The attempt number is the opposite: it changes on every retry
 * of every step. Baking it into the key would mint a fresh handler (and
 * re-register every tool) per attempt; storing it as a mutable field on the
 * shared context would race, because two runs of the SAME agent hit the same
 * cached handler and tool handlers await between reading and using it.
 *
 * AsyncLocalStorage is the primitive that fits: the value is scoped to one
 * request's async execution, survives awaits, and is invisible to every
 * other in-flight request sharing the handler.
 *
 * The engine sends the numbers as request headers on each tool call; the
 * MCP route wraps its dispatch in `withAttempt`. Anything reading this must
 * cope with `undefined` — a human calling the same tool from Claude is not
 * on an attempt at all.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AttemptInfo {
  /** Which try this is, counting from 1. */
  attempt: number;
  /** How many tries the step is allowed. */
  maxAttempts: number;
}

const storage = new AsyncLocalStorage<AttemptInfo>();

/** Headers the agent runner stamps on each tool call. */
export const ATTEMPT_HEADER = 'x-renkei-attempt';
export const ATTEMPT_MAX_HEADER = 'x-renkei-attempt-max';

/**
 * Read the attempt off request headers.
 *
 * Returns undefined unless BOTH are present and sane. A caller that can
 * forge headers gains nothing here — the value is advisory context for a
 * tool's own behaviour, never an authorization input — but a half-parsed
 * `{attempt: 3, maxAttempts: NaN}` would read as truth downstream, so the
 * pair is taken or neither is.
 */
export function attemptFromHeaders(headers: Headers): AttemptInfo | undefined {
  const attempt = Number(headers.get(ATTEMPT_HEADER));
  const maxAttempts = Number(headers.get(ATTEMPT_MAX_HEADER));
  if (!Number.isInteger(attempt) || attempt < 1) return undefined;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return undefined;
  if (attempt > maxAttempts) return undefined;
  return { attempt, maxAttempts };
}

/** Run `work` with `info` visible to `currentAttempt()` throughout. */
export function withAttempt<T>(info: AttemptInfo | undefined, work: () => T): T {
  return info ? storage.run(info, work) : work();
}

/**
 * The attempt this tool call belongs to, or undefined when the caller is
 * not an agent retrying a step — a person, or an agent's first try.
 */
export function currentAttempt(): AttemptInfo | undefined {
  return storage.getStore();
}

/**
 * A line for a tool to add to its own output when it is being retried.
 *
 * Centralised so every tool that mentions a retry says it the same way,
 * matching the builder's "tries" vocabulary rather than inventing a third
 * spelling.
 */
export function retryNote(): string | undefined {
  const info = currentAttempt();
  if (!info || info.attempt < 2) return undefined;
  return `(try ${info.attempt} of ${info.maxAttempts} — the previous try did not succeed.)`;
}
