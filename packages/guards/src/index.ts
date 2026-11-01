/**
 * Type guards for values whose shape is not known yet: a JSON body, a
 * vendor's answer, a postMessage, a row's JSON column, an error's cause.
 * One copy for the whole repository, dependency-free so the browser, the
 * preview cards' bundles and every worker can import it. A local copy of
 * one of these fails src/no-copies.test.ts.
 */

/**
 * An object whose fields can be read by name: not null, and not an array
 * (an array is an object too, and `[].id` reading undefined hides that the
 * value was the wrong shape).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The value when it is a record, otherwise an empty one: for reading
 * optional fields off something that may be missing or the wrong shape
 * (`asRecord(body.meta).id`). The value itself, not a copy.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The value when it is a record, otherwise null: for telling "absent" apart from "empty". */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** A string, of any length (for `.filter(isString)` over a mixed array). */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}
