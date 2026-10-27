/**
 * The wire form of data-store calls made over the test route
 * (app/api/test/data-store) by the Playwright client (e2e/support/store.ts):
 * plain JSON, with the values JSON cannot carry tagged so each side
 * revives them —
 *
 *   Date       ⇄ { $date: '<ISO string>' }
 *   undefined  ⇄ { $undefined: true }   (an argument left out, a field unset)
 *
 * Pure and dependency-free: the route imports it, and so does the spec
 * side, which Playwright transpiles on its own.
 */

/**
 * One store call: `agents.create` with its arguments. `at` runs it as of
 * that moment — every "now" the store stamps (created_at, finished now, a
 * ledger row dated now) reads that instant instead — so a fixture can
 * write yesterday's run through the same methods today's run uses.
 */
export interface WireCall {
  method: string;
  args: unknown[];
  at?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value made safe for JSON.stringify, its Dates and undefineds tagged. */
export function encodeWire(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeWire);
  if (typeof value === 'function') {
    throw new Error('A function cannot cross the data-store wire');
  }
  if (typeof value === 'bigint') return value.toString();
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeWire(item)]));
  }
  return value;
}

/** The inverse of `encodeWire`, over what JSON.parse returned. */
export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$date === 'string') return new Date(value.$date);
    if (keys.length === 1 && value.$undefined === true) return undefined;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeWire(item)]));
  }
  return value;
}

/** `{ calls: [{ method, args }, …] }`, or null when the body is something else. */
export function wireCallsOf(body: unknown): WireCall[] | null {
  if (!isRecord(body) || !Array.isArray(body.calls)) return null;
  const calls: WireCall[] = [];
  for (const call of body.calls) {
    if (!isRecord(call) || typeof call.method !== 'string') return null;
    const args = call.args ?? [];
    if (!Array.isArray(args)) return null;
    let at: Date | undefined;
    if (call.at !== undefined) {
      if (typeof call.at !== 'string' || Number.isNaN(Date.parse(call.at))) return null;
      at = new Date(call.at);
    }
    calls.push({ method: call.method, args, ...(at ? { at } : {}) });
  }
  return calls;
}
