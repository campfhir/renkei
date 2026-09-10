/**
 * Which connectors a person is in the audience of.
 *
 * An admin can scope a connector to people carrying certain IdP group
 * claims; everyone else must neither see its card nor have its tools
 * registered. This module answers that question per subject, from the
 * database — never from token roles, because agent-run tokens carry none.
 *
 * Until audience rules exist for a connector, the answer is "everyone".
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

/** The audience gate's verdict per capability key. */
export type AudienceAllows = (capabilityKey: string) => boolean;

export async function resolveAudienceAllows(
  _db: Kysely<DB>,
  _tenantId: string,
  _subject: string
): Promise<AudienceAllows> {
  return () => true;
}
