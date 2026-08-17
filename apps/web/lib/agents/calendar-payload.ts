/**
 * The schedule-calendar admin payload: a name plus a BlackoutEntry[].
 * Shared by the collection and item routes so both validate identically.
 */

import { isBlackoutEntry, type BlackoutEntry } from '@renkei/agents';

export const MAX_CALENDAR_DATES = 100;

export function parseCalendarPayload(
  body: unknown
): { name: string; dates: BlackoutEntry[] } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Malformed payload' };
  }
  const record: { name?: unknown; dates?: unknown } = body;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name || name.length > 100) {
    return { error: 'name is required (at most 100 characters)' };
  }
  const dates = Array.isArray(record.dates) ? record.dates : [];
  if (dates.length > MAX_CALENDAR_DATES) {
    return { error: `A calendar holds at most ${MAX_CALENDAR_DATES} entries` };
  }
  if (!dates.every(isBlackoutEntry)) {
    return { error: 'An entry is not a valid date, range, or annual date' };
  }
  return { name, dates };
}
