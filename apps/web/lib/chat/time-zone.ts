/**
 * The person's timezone as their browser reported it with a prompt
 * (client.ts). Only a zone Intl itself recognizes is kept: the value goes
 * into the system prompt verbatim, so anything else — a typo, a payload
 * someone crafted — is dropped rather than repeated to the model.
 */

import { isValidTimezone } from '@renkei/agents';

/** The longest IANA zone name is ~32 characters; this leaves headroom. */
const MAX_LENGTH = 64;

export function timeZoneOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const zone = value.trim();
  if (!zone || zone.length > MAX_LENGTH || !isValidTimezone(zone)) return null;
  return zone;
}
