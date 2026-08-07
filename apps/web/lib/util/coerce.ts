/**
 * Narrowing helpers for untyped REST payloads.
 *
 * `String(value)` on an unknown field silently produces `[object Object]` when
 * Jira returns a shape that changed; these return the fallback instead, so a
 * surprise never reaches the model as a plausible-looking string.
 */

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
