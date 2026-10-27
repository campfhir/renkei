/**
 * The database for a call into code not yet behind the data store — a
 * function another area or package still takes a Kysely handle for
 * (`resolveAgentLlm`, `recordLlmCall`, `mintRunToken`, `createAttachment`,
 * …). Reached for at the call, lazily, so a path that never makes such a
 * call never needs a database; throws when there is none (the caller's
 * 500, or a tool's failure). Each use goes once its callee reads through
 * `getDataStore()`.
 */

import type { Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';

export function databaseForUnconvertedCode(): Kysely<DB> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('Database unavailable');
  return dbResult.val;
}
