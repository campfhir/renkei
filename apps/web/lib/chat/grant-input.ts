/**
 * The share modal's expiry: a date-time string, null for open-ended, or
 * `undefined` when the value is not a usable future instant.
 */

export function parseExpiry(value: unknown): Date | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  if (date.getTime() <= Date.now()) return undefined;
  return date;
}
