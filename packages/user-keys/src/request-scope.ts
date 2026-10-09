/**
 * What the delegate knows about the request a key op runs inside
 * (docs/delegate-key-design.md, "Callers"): who is calling, and which
 * browser session — if any — the op is bound to. The bearer key alone used
 * to be the whole trust boundary; now a ring is opened under these rules:
 *
 *   - a caller that is not the web app never opens a SESSION ring. The
 *     queue and agents workers act unattended, so the automation key is
 *     all they may hold; a compromised worker key cannot reach a person's
 *     conversation history, memory or private key.
 *   - a request that names a session uses that session's delegation and no
 *     other, after the delegate has checked the session belongs to the
 *     tenant and subject the body names and has not expired.
 *
 * Carried on AsyncLocalStorage so the store functions keep their shape;
 * outside a scope (tests, in-process use) everything is allowed, as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

export interface KeyRequestScope {
  /** The caller the bearer key named. */
  caller: string;
  /** Whether this caller may open a session ring at all. */
  allowSession: boolean;
  /** The browser session the request is bound to, verified by `verifySession`; null for none. */
  sessionId: string | null;
}

const storage = new AsyncLocalStorage<KeyRequestScope>();

/** Run `work` with `scope` as the request's key scope. */
export function withKeyRequestScope<T>(scope: KeyRequestScope, work: () => Promise<T>): Promise<T> {
  return storage.run(scope, work);
}

/** The current request's scope, or null outside one (everything allowed). */
export function keyRequestScope(): KeyRequestScope | null {
  return storage.getStore() ?? null;
}

export interface SessionCheck {
  expiresAt: Date;
}

/**
 * The session row, when it is this person's and still live. A session id a
 * caller made up, another person's session, or an expired one all read as
 * null, and the op that named it is refused (`SESSION_MISMATCH`).
 */
export async function verifySession(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  sessionId: string
): Promise<SessionCheck | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const row = await db
    .selectFrom('sessions')
    .select('expires_at')
    .where('id', '=', sessionId)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  return row ? { expiresAt: row.expires_at } : null;
}
