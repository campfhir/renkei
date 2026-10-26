/**
 * Who and where the code writing a log line is working for: the request's
 * browser agent and page, and the signed-in person once a route knows them.
 * Stored on AsyncLocalStorage and read by @renkei/logging, so a line written
 * inside the request carries them without its call site passing them.
 *
 * Anchored on globalThis for the same reason the logger is: Next evaluates
 * the server's modules once per compilation graph, and every copy has to
 * share one store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { registerLogContext, type LogContext } from '@renkei/logging';

const anchor = globalThis as unknown as { __renkeiLogStore?: AsyncLocalStorage<LogContext> };
const store = (anchor.__renkeiLogStore ??= new AsyncLocalStorage<LogContext>());

registerLogContext(() => store.getStore());

/** Runs `work` with `context` as the request's log context. */
export function withLogContext<T>(context: LogContext, work: () => Promise<T>): Promise<T> {
  return store.run(context, work);
}

/** The browser agent and the path of a request, for `withLogContext`. */
export function requestLogContext(request: Request): LogContext {
  return {
    browserAgent: request.headers.get('user-agent') ?? undefined,
    page: new URL(request.url).pathname,
  };
}
