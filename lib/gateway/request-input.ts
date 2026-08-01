/**
 * Reading strings out of a request body or query string.
 *
 * Fastify parses JSON and form bodies into `unknown`, and every route here used
 * to reach into that with a cast — `(request.body as { csrf?: string })?.csrf`.
 * The cast is a claim about a value that arrived over the network, and it is
 * wrong as often as an attacker likes: `{"csrf": 123}` satisfies the compiler,
 * then throws inside whatever string operation runs next. A 500 on a malformed
 * body is both a worse answer than a 400 and a signal about what the code
 * believed, so the guards live here and the casts are gone.
 *
 * Query strings have a second trap. Fastify collapses `?a=1&a=2` into an array,
 * so `request.query as Record<string, string | undefined>` describes a shape
 * the runtime does not guarantee — and an array reaching a `::timestamptz` bind
 * parameter fails in the driver rather than in validation. `queryString` takes
 * the first value, which is the only reading that cannot surprise a caller.
 */

import type { FastifyRequest } from 'fastify';

/** A non-empty string, or null. Anything else — number, array, object — is null. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One field of the body as a non-empty string, or null. */
export function bodyString(request: FastifyRequest, field: string): string | null {
  const body = record(request.body);
  return body === null ? null : asString(body[field]);
}

/**
 * One body field, trimmed, defaulting to `''`.
 *
 * The shape most form handlers want: they treat blank and absent the same, and
 * they were all writing `(... ?? '').trim()` around a cast to get here.
 */
export function bodyText(request: FastifyRequest, field: string): string {
  return (bodyString(request, field) ?? '').trim();
}

/**
 * One query parameter as a non-empty string, or null.
 *
 * Takes the first value of a repeated key rather than rejecting it: a duplicated
 * parameter is a client bug, not an attack worth a different answer, and every
 * caller here wants one value.
 */
export function queryString(request: FastifyRequest, field: string): string | null {
  const query = record(request.query);
  if (query === null) return null;

  const value = query[field];
  if (Array.isArray(value)) {
    return value.length === 0 ? null : asString(value[0]);
  }

  return asString(value);
}

/**
 * The whole query string as the record the old cast merely claimed it was.
 *
 * For handlers that read several parameters — the OAuth authorize endpoint reads
 * eight — this is one normalization instead of one guard per field. Repeated keys
 * collapse to their first value and non-string values drop out, so `query.state`
 * is a `string | undefined` because it has been made one, not because a cast said
 * so.
 */
export function queryStrings(request: FastifyRequest): Record<string, string | undefined> {
  const query = record(request.query);
  if (query === null) return {};

  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(query)) {
    const value: unknown = query[key];
    const first: unknown = Array.isArray(value) ? value[0] : value;
    const asStr = asString(first);
    if (asStr !== null) out[key] = asStr;
  }

  return out;
}

/**
 * A query parameter as a positive integer, or the fallback.
 *
 * Used for page sizes, where `?limit=abc` and `?limit=-1` and `?limit=1e9` all
 * have to become something finite before they reach a `LIMIT` clause.
 */
export function queryInt(
  request: FastifyRequest,
  field: string,
  fallback: number,
  max: number,
): number {
  const raw = queryString(request, field);
  if (raw === null) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;

  return Math.min(parsed, max);
}

/**
 * A query parameter constrained to a known set of values.
 *
 * `(query.format as 'json-lines' | 'syslog')` was a cast that let `?format=xml`
 * through as a type the rest of the code then trusted.
 */
export function queryEnum<const T extends readonly string[]>(
  request: FastifyRequest,
  field: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const raw = queryString(request, field);
  return raw !== null && allowed.includes(raw) ? raw : fallback;
}
