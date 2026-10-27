/**
 * The database handle for the few questions the admin-change gates still
 * ask of modules not yet behind the data store (lib/mcp-tools/registry.ts's
 * connector availability, the Jira Service Management and automation grant
 * checks). Their own records go through getDataStore(); this goes away once
 * those modules take no `db`.
 */

import type { Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';

/** The database, or null when there is none to ask (an outage, or the memory store). */
export function legacyDatabase(): Kysely<DB> | null {
  const result = getDatabase();
  return result.ok ? result.val : null;
}

export const NO_DATABASE_REASON = 'Could not reach the database to check this.';
