/**
 * Who did this, in words — for logs.
 *
 * A log line naming only `subject` ("5b21a397a6d3c211bbc5f967", an OIDC
 * subject or a provider account id) is unreadable to the person most likely
 * to be reading it, and a line naming only a display name cannot be joined
 * back to a row. So actor fields always come as BOTH: a name to read and an
 * id to search on.
 *
 * Cached briefly because logging must never become a query amplifier — a
 * sweep touching fifty watches should not make fifty identity reads for
 * fifty lines about the same person.
 */

import type { Kysely } from 'kysely';
import type { DB } from './db.types';

export interface Actor {
  /** The internal id — always present, always logged, always joinable. */
  subject: string;
  /** Display name, or the email, or the subject when nothing better exists. */
  displayName: string;
}

interface CacheEntry {
  actor: Actor;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;
const cache = new Map<string, CacheEntry>();

/**
 * The actor for a subject. Never throws and never returns null: an
 * unresolvable identity still logs as its subject, because a log line that
 * disappears because a name lookup failed is worse than one with an ugly
 * name.
 */
export async function describeActor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string | null | undefined
): Promise<Actor> {
  if (!subject) return { subject: '(none)', displayName: '(none)' };
  const key = `${tenantId}:${subject}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.actor;

  let displayName = subject;
  try {
    const row = await db
      .selectFrom('identities')
      .select(['display_name', 'email'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .executeTakeFirst();
    displayName = row?.display_name || row?.email || subject;
  } catch {
    // Logging is never worth failing the work it describes.
  }

  if (cache.size >= MAX_ENTRIES) cache.clear();
  const actor: Actor = { subject, displayName };
  cache.set(key, { actor, expiresAt: now + CACHE_TTL_MS });
  return actor;
}

/**
 * The actor behind a PROVIDER account id (a Graph or Atlassian account),
 * which is what connector-side rows carry instead of a subject.
 */
export async function describeAccountActor(
  db: Kysely<DB>,
  tenantId: string,
  accountId: string | null | undefined
): Promise<Actor> {
  if (!accountId) return { subject: '(none)', displayName: '(none)' };
  const key = `${tenantId}:account:${accountId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.actor;

  let subject = accountId;
  let displayName = accountId;
  try {
    const grant = await db
      .selectFrom('provider_grants')
      .select(['subject', 'display_name'])
      .where('tenant_id', '=', tenantId)
      .where('provider_account_id', '=', accountId)
      .executeTakeFirst();
    if (grant?.subject) {
      subject = grant.subject;
      const resolved = await describeActor(db, tenantId, grant.subject);
      displayName = resolved.displayName;
    } else if (grant?.display_name) {
      displayName = grant.display_name;
    }
  } catch {
    // As above: never fail the work for the sake of its log line.
  }

  if (cache.size >= MAX_ENTRIES) cache.clear();
  const actor: Actor = { subject, displayName };
  cache.set(key, { actor, expiresAt: now + CACHE_TTL_MS });
  return actor;
}

/** Test seam. */
export function resetActorCache(): void {
  cache.clear();
}
