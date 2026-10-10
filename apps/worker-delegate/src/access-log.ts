/**
 * The delegate's access log (docs/delegate-key-design.md, "Callers"): one
 * structured line per op naming who called, what, for whom and how it
 * ended — never a key, a token, a sealed box or a plaintext — and, for the
 * handful of ops that destroy or hand out something (a shred, a rotation,
 * a share, a git ticket, a write through the token proxy), an append-only
 * row in `delegate_access_events` (migration 144) that an operator can
 * read back after the fact. Subjects are hashed in both places: the log is
 * for "what happened", and the person is recoverable by hashing a known
 * subject, not by reading the table.
 */

import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { DelegateLogger } from './grants';

export type AccessOutcome = 'ok' | 'refused' | 'failed';

export interface AccessEvent {
  caller: string;
  op: string;
  subject: string;
  /** An id the op was about (a resource id, a grant's account id, a provider), never content. */
  target?: string;
  outcome: AccessOutcome;
  status: number;
  /** Write the row as well as the line. */
  persist: boolean;
}

/** Ops whose every call is kept as a row, whatever the outcome. */
export const PERSISTED_OPS: ReadonlySet<string> = new Set([
  'keys/shred',
  'keys/rotate',
  'resource-key/share',
  'grant/git-ticket',
]);

/** A short, stable stand-in for a subject: the first sixteen hex characters of its SHA-256. */
export function subjectHash(subject: string): string {
  return subject ? createHash('sha256').update(subject).digest('hex').slice(0, 16) : '-';
}

export function outcomeOf(status: number): AccessOutcome {
  if (status < 400) return 'ok';
  return status >= 500 ? 'failed' : 'refused';
}

export class AccessLog {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly logger: DelegateLogger
  ) {}

  async record(event: AccessEvent): Promise<void> {
    const hashed = subjectHash(event.subject);
    this.logger.info('delegate {op} by {caller} for {subjectHash}: {outcome} {status}', {
      component: 'worker-delegate/access',
      caller: event.caller,
      op: event.op,
      subjectHash: hashed,
      target: event.target ?? '-',
      outcome: event.outcome,
      status: event.status,
    });
    if (!event.persist) return;
    try {
      await this.db
        .insertInto('delegate_access_events')
        .values({
          caller: event.caller.slice(0, 32),
          op: event.op.slice(0, 64),
          subject_hash: event.subject ? hashed : null,
          target: event.target ? event.target.slice(0, 200) : null,
          outcome: event.outcome,
          status: event.status,
        })
        .execute();
    } catch (error) {
      this.logger.warn('delegate access event not recorded for {op}: {error}', {
        component: 'worker-delegate/access',
        op: event.op,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
