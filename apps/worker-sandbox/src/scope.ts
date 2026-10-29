/**
 * The scratch-space scope a caller names (migration 169, store.ts's
 * SandboxTarget): `chat:<id>` or `project:<id>`, or nothing for the
 * person's own scratch space.
 */

const SCOPE_PATTERN = /^(chat|project):[0-9a-f-]{36}$/i;

/** A caller's scope as the wire carries it: '' for none, null for one that is not well-formed. */
export function scopeOf(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return '';
  return typeof value === 'string' && SCOPE_PATTERN.test(value) ? value : null;
}
