/**
 * Fixtures for the in-memory data store — the UI suite's way of putting
 * rows in front of a page (playwright.memory.config.ts, e2e/memory/).
 *
 *   POST   { <table>: [row, …], … }  add rows, shaped as the table's columns
 *                                    (the memory tables fill defaults and
 *                                    refuse what Postgres would refuse);
 *                                    `?replace=1` overwrites rows whose
 *                                    primary key is already there
 *   GET                              direct database calls made since the
 *                                    last reset: code that bypassed the
 *                                    data store (e2e/memory/crawl.spec.ts)
 *   DELETE { subject?: string,       forget one subject's rows, or everything;
 *            calls?: true }          `calls` clears only the call log
 *
 * Answers 404 — as if it did not exist — unless this process runs on the
 * memory store (RENKEI_DATA_STORE=memory, see instrumentation.ts) AND the
 * request carries RENKEI_MEMORY_SEED_TOKEN in `x-renkei-seed-token`. A
 * deployment on Postgres can never reach a store through here: there is
 * no memory store to reach.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  directDatabaseCalls,
  getMemoryDataStore,
  resetDirectDatabaseCalls,
  type MemoryDataStore,
  type TableRows,
} from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const store = authorizedStore(request);
  if (!store) return notFound();

  const body: unknown = await request.json().catch(() => null);
  if (!isTableRows(body)) {
    return NextResponse.json({ error: 'Expected { table: [row, …] }' }, { status: 400 });
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorizedStore(request)) return notFound();
  return NextResponse.json({ directDatabaseCalls: directDatabaseCalls() });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const store = authorizedStore(request);
  if (!store) return notFound();

  const body: unknown = await request.json().catch(() => ({}));
  if (isObject(body) && body.calls === true) {
    resetDirectDatabaseCalls();
    return NextResponse.json({ reset: 'calls' });
  }
  const subject = isObject(body) && typeof body.subject === 'string' ? body.subject : undefined;
  store.reset(subject);
  return NextResponse.json({ reset: subject ?? 'all' });
}
