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
import { getDataStore } from '@renkei/db';
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

/**
 * How a delegate line names a person: by the hash of their subject, under
 * the same `actor` key the rest of the fleet puts a display name and email
 * under (docs/logging.md), so the sentences keep their shape while this
 * process — the one holding everyone's keys — writes no name or email into
 * its log. The web app's Activity view hashes a known subject the same way
 * to find their lines.
 */
export function pseudonym(subject: string | null | undefined): {
  subjectHash: string | null;
  actor: string;
} {
  if (!subject) return { subjectHash: null, actor: 'nobody in particular' };
  const hashed = subjectHash(subject);
  return { subjectHash: hashed, actor: `the person ${hashed}` };
}

/** A short, stable stand-in for a subject: the first sixteen hex characters of its SHA-256. */
export function subjectHash(subject: string): string {
  return subject ? createHash('sha256').update(subject).digest('hex').slice(0, 16) : '-';
}

export function outcomeOf(status: number): AccessOutcome {
  if (status < 400) return 'ok';
  return status >= 500 ? 'failed' : 'refused';
}

export class AccessLog {
  constructor(private readonly logger: DelegateLogger) {}

  async record(event: AccessEvent): Promise<void> {
    const hashed = subjectHash(event.subject);
    // The person as the delegate names them: a hash, never a name (header).
    // An op with no subject (a forward whose body names them) says so.
    const who = pseudonym(event.subject);
    const about = {
      component: 'worker-delegate/access',
      ...who,
      caller: event.caller,
      op: event.op,
      subjectHash: hashed,
      forWhom: `for ${who.actor}`,
      target: event.target ?? '-',
      outcome: event.outcome,
      status: event.status,
    };
    this.logger.info(
      'the {caller} caller ran the delegate op {op} {forWhom}: {outcome} ({status})',
      about
    );
    if (!event.persist) return;
    try {
      await getDataStore().delegateAccessEvents.record({
        caller: event.caller.slice(0, 32),
        op: event.op.slice(0, 64),
        subjectHash: event.subject ? hashed : null,
        target: event.target ? event.target.slice(0, 200) : null,
        outcome: event.outcome,
        status: event.status,
      });
    } catch (error) {
      this.logger.warn(
        'the audit row for the delegate op {op} the {caller} caller ran {forWhom} was not written; only this line records it: {error}',
        {
          ...about,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }
}
