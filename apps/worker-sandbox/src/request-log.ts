import { AsyncLocalStorage } from 'node:async_hooks';
import { actorAttrs } from '@renkei/db';
import { logger } from './logger';

/**
 * Who a request is for, so a failure answered deep inside an endpoint
 * module logs with the op and the person's subject without every
 * `sendError` having to be handed them.
 */
interface RequestScope {
  op: string;
  subject?: string;
}

const scope = new AsyncLocalStorage<RequestScope>();

export function withRequestScope<T>(op: string, subject: string, run: () => T): T {
  return scope.run({ op, subject: subject || undefined }, run);
}

/**
 * The line every endpoint's `sendError` writes for a 5xx: the worker
 * failed at what was asked. 4xx answers are the caller's mistake and stay
 * quiet; `internal` comes only after the unhandled-error handler logged it.
 */
export function logErrorResponse(status: number, type: string, message?: string): void {
  if (status < 500 || type === 'internal') return;
  const current = scope.getStore();
  // `sendError` is synchronous; the name lookup is cached and never throws,
  // so the line is written as soon as it answers.
  void actorAttrs(current?.subject).then((who) => {
    logger.warn('the sandbox could not do {op} for {forWhom} ({type}, {status}): {error}', {
      component: 'worker-sandbox/server',
      ...(current?.subject ? who : {}),
      op: current?.op ?? 'request',
      forWhom: current?.subject ? who.actor : 'an unnamed caller',
      type,
      status,
      error: message ?? type,
    });
  });
}
