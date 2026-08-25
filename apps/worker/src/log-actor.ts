/**
 * Naming the person behind a sweep, without ever risking the sweep.
 *
 * These lookups exist purely so a log line reads "for Scott Eremia-Roden"
 * instead of "for 5b21a397a6d3c211bbc5f967". That is worth a query and it is
 * NOT worth an exception: indexing that fails because a display name could
 * not be resolved would be a spectacularly bad trade, and a jest mock
 * missing the export is enough to cause exactly that.
 *
 * So: total functions. Anything unexpected degrades to the id, which is
 * still the thing you would search on.
 */

import { describeAccountActor, describeActor, type Actor } from '@renkei/db';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

function fallback(id: string | null | undefined): Actor {
  return { subject: id ?? '(none)', displayName: id ?? '(none)' };
}

/** The Renkei user behind an OIDC subject. Never throws. */
export async function actorForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string | null | undefined
): Promise<Actor> {
  try {
    return await describeActor(db, tenantId, subject);
  } catch {
    return fallback(subject);
  }
}

/** The Renkei user behind a provider account id. Never throws. */
export async function actorForAccount(
  db: Kysely<DB>,
  tenantId: string,
  accountId: string | null | undefined
): Promise<Actor> {
  try {
    return await describeAccountActor(db, tenantId, accountId);
  } catch {
    return fallback(accountId);
  }
}
