/**
 * Postgres's jsonb text forms, for the agent domains' memory
 * implementations: `value ->> 'key'` and `value::text`.
 *
 * jsonb prints objects with their keys ordered by length, then bytewise,
 * and separates with ", " and ": " — reproduced here. What cannot be:
 * a number keeps the text it was written with in jsonb (1.0 stays 1.0),
 * while a parsed JavaScript number prints in its shortest form (1); the
 * memory store holds parsed JSON, so such a value prints differently.
 * Callers' scenarios stay with integers and strings, where the two agree.
 */

function compareKeys(a: string, b: string): number {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return left.length - right.length;
  return Buffer.compare(left, right);
}

/** `value::text` for a jsonb value. */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([key, field]) => `${JSON.stringify(key)}: ${jsonbText(field)}`);
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** `value ->> key`: a string field as itself, null for a missing key or JSON null. */
export function jsonField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field: unknown = Reflect.get(value, key);
  if (field === null || field === undefined) return null;
  return typeof field === 'string' ? field : jsonbText(field);
}
