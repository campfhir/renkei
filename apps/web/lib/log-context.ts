/**
 * Who and where the code writing a log line is working for, on the server:
 *
 *   - the browser agent (the request's User-Agent header),
 *   - the page the person was on (the x-renkei-page header the browser sends
 *     on every API call, lib/client-logs.ts),
 *   - the route the request was made to,
 *   - and the signed-in person, once the session has been looked up
 *     (lib/session.ts calls noteLogUser).
 *
 * Every route handler runs inside this context (routeLog), so a line written
 * anywhere below it carries all of them without its call site passing them.
 *
 * Stored on AsyncLocalStorage and anchored on globalThis, because Next
 * evaluates the server's modules once per compilation graph and every copy has
 * to share one store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { registerLogContext, type LogContext } from '@renkei/logging';

const anchor = globalThis as unknown as { __renkeiLogStore?: AsyncLocalStorage<LogContext> };
const store = (anchor.__renkeiLogStore ??= new AsyncLocalStorage<LogContext>());

registerLogContext(() => store.getStore());

/** The page header the browser sends, capped: a path and query, not a document. */
const PAGE_HEADER = 'x-renkei-page';
const MAX_PAGE_CHARS = 300;

/** Runs `work` with `context` as the request's log context. */
export function withLogContext<T>(context: LogContext, work: () => Promise<T>): Promise<T> {
  return store.run({ ...context }, work);
}

/** Records the signed-in person on the current request's context, if there is one. */
export function noteLogUser(subject: string): void {
  const current = store.getStore();
  if (current) {
    current.user = subject;
    return;
  }
  // A server component renders outside any route wrapper: the context starts
  // here, for the rest of this render.
  store.enterWith({ user: subject });
}

/** What a request says about its caller, for the log context. */
export function requestLogContext(request: Request): LogContext {
  const page = request.headers.get(PAGE_HEADER);
  return {
    browserAgent: request.headers.get('user-agent') ?? undefined,
    page: page ? page.slice(0, MAX_PAGE_CHARS) : undefined,
    route: new URL(request.url).pathname,
  };
}

/**
 * Wraps a route handler so it runs inside the request's log context. The
 * handler's arguments and result are passed through unchanged, so Next still
 * sees the handler it expects.
 */
export function routeLog<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args: A) => {
    const request = args.find((arg): arg is Request => arg instanceof Request);
    return withLogContext(request ? requestLogContext(request) : {}, () => handler(...args));
  };
}
