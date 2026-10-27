/**
 * Fixtures for the in-memory data store — the UI suite's way of putting
 * rows in front of a page (playwright.memory.config.ts, e2e/memory/).
 *
 *   POST   { calls: [{ method: 'agents.create', args: [...] }, …] }
 *                                    run store methods, in order, as the app
 *                                    would (`getMemoryDataStore().agents
 *                                    .create(...args)`); answers
 *                                    `{ results: [...] }`. Dates travel as
 *                                    `{ $date: iso }` both ways
 *                                    (lib/data-store-wire.ts); an unknown
 *                                    domain or method is a 400, a call that
 *                                    rejects a 409 naming its index. A
 *                                    call's `at` (ISO) runs it as of that
 *                                    moment: the store's "now" reads it. The
 *                                    Playwright client is e2e/support/store.ts.
 *   POST   { <table>: [row, …], … }  add raw rows, shaped as the table's columns
 *                                    (the memory tables fill defaults and
 *                                    refuse what Postgres would refuse);
 *                                    `?replace=1` overwrites rows whose
 *                                    primary key is already there (the
 *                                    crawl fixtures' path, until they move
 *                                    to store calls)
 *   DELETE { subject?: string }      forget one subject's rows, or everything
 *
 * Answers 404 — as if it did not exist — unless this process runs on the
 * memory store (RENKEI_DATA_STORE=memory, see instrumentation.ts) AND the
 * request carries RENKEI_MEMORY_SEED_TOKEN in `x-renkei-seed-token`. A
 * deployment on Postgres can never reach a store through here: there is
 * no memory store to reach.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getMemoryDataStore, type MemoryDataStore, type TableRows } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { decodeWire, encodeWire, wireCallsOf, type WireCall } from '@/lib/data-store-wire';

const TOKEN_HEADER = 'x-renkei-seed-token';

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

function authorizedStore(request: NextRequest): MemoryDataStore | null {
  const store = getMemoryDataStore();
  const expected = process.env.RENKEI_MEMORY_SEED_TOKEN ?? '';
  const presented = request.headers.get(TOKEN_HEADER) ?? '';
  if (!store || expected.length === 0) return null;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? store : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tables to arrays of rows; what each row holds is the memory tables' to check. */
function isTableRows(value: unknown): value is TableRows {
  return (
    isObject(value) &&
    Object.values(value).every((rows) => Array.isArray(rows) && rows.every(isObject))
  );
}

/** What a memory store holds beside its domains: never callable from here. */
const NOT_DOMAINS = new Set(['kind', 'tables', 'seed', 'reset']);

type Resolved = { ok: true; run: () => unknown } | { ok: false; error: string };

/** `domain.method` on the store, bound and ready to run, or why not. */
function resolveCall(store: MemoryDataStore, call: WireCall): Resolved {
  const [domain, method, ...rest] = call.method.split('.');
  if (!domain || !method || rest.length > 0) {
    return { ok: false, error: `Expected "domain.method", got "${call.method}"` };
  }
  const repository: unknown = NOT_DOMAINS.has(domain) ? undefined : Reflect.get(store, domain);
  if (typeof repository !== 'object' || repository === null) {
    return { ok: false, error: `Unknown data-store domain "${domain}"` };
  }
  const fn: unknown =
    method === 'constructor' || method.startsWith('_')
      ? undefined
      : Reflect.get(repository, method);
  if (typeof fn !== 'function') {
    return { ok: false, error: `Unknown method "${method}" on data-store domain "${domain}"` };
  }
  const args = call.args.map(decodeWire);
  const run = () => Reflect.apply(fn, repository, args);
  const at = call.at;
  return { ok: true, run: at ? () => asOf(at, run) : run };
}

/**
 * Run `fn` with the process clock reading `at`: `new Date()` and
 * `Date.now()` answer that instant, every other Date as usual. The memory
 * store does no I/O, so a call settles within microtasks — before this
 * process takes up any other request — and the clock is back before
 * anything else can read it.
 */
async function asOf(at: Date, fn: () => unknown): Promise<unknown> {
  const RealDate = globalThis.Date;
  const fixed = at.getTime();
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [fixed] : args, newTarget),
    apply: (target, thisArg, args) =>
      args.length === 0 ? new RealDate(fixed).toString() : Reflect.apply(target, thisArg, args),
    get: (target, key, receiver) =>
      key === 'now' ? () => fixed : Reflect.get(target, key, receiver),
  });
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Run the calls in order; the first that rejects stops the rest. */
async function runCalls(store: MemoryDataStore, calls: WireCall[]): Promise<NextResponse> {
  const resolved: (() => unknown)[] = [];
  for (const call of calls) {
    const found = resolveCall(store, call);
    if (!found.ok) return NextResponse.json({ error: found.error }, { status: 400 });
    resolved.push(found.run);
  }
  const results: unknown[] = [];
  for (const [index, run] of resolved.entries()) {
    const outcome = await wrapAsync(async () => run(), 'CALL_ERROR' as const);
    if (!outcome.ok) {
      const cause = outcome.err.cause;
      return NextResponse.json(
        {
          error: `${calls[index]?.method}: ${cause instanceof Error ? cause.message : 'rejected'}`,
          index,
        },
        { status: 409 }
      );
    }
    results.push(encodeWire(outcome.val));
  }
  return NextResponse.json({ results });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const store = authorizedStore(request);
  if (!store) return notFound();

  const body: unknown = await request.json().catch(() => null);
  const calls = wireCallsOf(body);
  if (calls) return runCalls(store, calls);
  if (!isTableRows(body)) {
    return NextResponse.json(
      { error: 'Expected { calls: [{ method, args }, …] } or { table: [row, …] }' },
      { status: 400 }
    );
  }

  const replace = request.nextUrl.searchParams.get('replace') === '1';
  const seeded = await wrapAsync(() => store.seed(body, { replace }), 'SEED_ERROR' as const);
  if (!seeded.ok) {
    const cause = seeded.err.cause;
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : 'Could not seed' },
      { status: 409 }
    );
  }
  return NextResponse.json({ seeded: true });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const store = authorizedStore(request);
  if (!store) return notFound();

  const body: unknown = await request.json().catch(() => ({}));
  const subject = isObject(body) && typeof body.subject === 'string' ? body.subject : undefined;
  store.reset(subject);
  return NextResponse.json({ reset: subject ?? 'all' });
}
