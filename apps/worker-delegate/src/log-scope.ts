import { AsyncLocalStorage } from 'node:async_hooks';
import { subjectHash } from './access-log';
import type { DelegateLogger } from './grants';

/**
 * Whom the op in flight is for, so every line written while it runs —
 * however deep, in grants, forward, mcp or git — carries the person's
 * `subjectHash` without each call site being handed it. The hash, never
 * the subject: the same stand-in the access log uses (access-log.ts). The
 * web app's Activity view hashes the signed-in person's subject the same
 * way to show them their own lines.
 */
const scope = new AsyncLocalStorage<{ subjectHash: string }>();

export function withLogSubject<T>(subject: string, run: () => T): T {
  return subject ? scope.run({ subjectHash: subjectHash(subject) }, run) : run();
}

/** The logger every module is handed: `base`, with the op's subjectHash added to each line. */
export function scopedLogger(base: DelegateLogger): DelegateLogger {
  const stamp = (context?: Record<string, unknown>) => {
    const current = scope.getStore();
    return current ? { subjectHash: current.subjectHash, ...context } : context;
  };
  return {
    debug: (message, context) => base.debug(message, stamp(context)),
    info: (message, context) => base.info(message, stamp(context)),
    warn: (message, context) => base.warn(message, stamp(context)),
    error: (message, context) => base.error(message, stamp(context)),
  };
}
