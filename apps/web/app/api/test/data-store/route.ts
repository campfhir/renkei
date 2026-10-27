/**
 * Fixtures for the in-memory data store — the UI suite's way of putting
 * rows in front of a page (playwright.memory.config.ts, e2e/memory/).
 *
 *   POST   { ...MemorySeed }      add sessions, identities, preferences,
 *                                 settings and notifications
 *   DELETE { subject?: string }   forget one subject's rows, or everything
 *
 * Answers 404 — as if it did not exist — unless this process runs on the
 * memory store (RENKEI_DATA_STORE=memory, see instrumentation.ts) AND the
 * request carries RENKEI_MEMORY_SEED_TOKEN in `x-renkei-seed-token`. A
 * deployment on Postgres can never reach a store through here: there is
 * no memory store to reach.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getMemoryDataStore, type MemoryDataStore, type MemorySeed } from '@renkei/db';
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

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const isDateish = (value: unknown): value is string | Date =>
  (typeof value === 'string' && !Number.isNaN(Date.parse(value))) || value instanceof Date;

function listOf<T>(value: unknown, parse: (entry: Fields) => T | null): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = isObject(entry) ? parse(entry) : null;
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** The seed body, field by field; null when anything in it is malformed. */
function parseSeed(body: Fields): MemorySeed | null {
  const sessions = listOf(body.sessions, (e) =>
    isString(e.id) && isString(e.subject) && isStringList(e.roles) && isDateish(e.expiresAt)
      ? { id: e.id, subject: e.subject, roles: e.roles, expiresAt: e.expiresAt }
      : null
  );
  const identities = listOf(body.identities, (e) =>
    isString(e.subject) && isString(e.email) && isNullableString(e.displayName ?? null)
      ? {
          subject: e.subject,
          email: e.email,
          displayName: isString(e.displayName) ? e.displayName : null,
          idpGroups: isStringList(e.idpGroups) ? e.idpGroups : [],
        }
      : null
  );
  const userPreferences = listOf(body.userPreferences, (e) =>
    isString(e.subject) && isString(e.key) && 'value' in e
      ? { subject: e.subject, key: e.key, value: e.value }
      : null
  );
  const settings = listOf(body.settings, (e) =>
    isString(e.key) && 'value' in e ? { key: e.key, value: e.value } : null
  );
  const optional = (value: unknown) => (isString(value) ? value : null);
  const notifications = listOf(body.notifications, (e) =>
    isString(e.id) &&
    isString(e.subject) &&
    isString(e.kind) &&
    isString(e.headline) &&
    (e.createdAt === undefined || isDateish(e.createdAt)) &&
    (e.readAt === undefined || e.readAt === null || isDateish(e.readAt))
      ? {
          id: e.id,
          subject: e.subject,
          kind: e.kind,
          headline: e.headline,
          category: optional(e.category),
          connector: optional(e.connector),
          tool: optional(e.tool),
          entity: optional(e.entity),
          refUrl: optional(e.refUrl),
          agentId: optional(e.agentId),
          agentName: optional(e.agentName),
          runId: optional(e.runId),
          meta: e.meta ?? null,
          ...(e.createdAt === undefined ? {} : { createdAt: e.createdAt }),
          readAt: e.readAt === undefined ? null : e.readAt,
        }
      : null
  );
  if (!sessions || !identities || !userPreferences || !settings || !notifications) return null;
  return { sessions, identities, userPreferences, settings, notifications };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const store = authorizedStore(request);
  if (!store) return notFound();

  const body: unknown = await request.json().catch(() => null);
  const seed = isObject(body) ? parseSeed(body) : null;
  if (!seed) return NextResponse.json({ error: 'Malformed seed' }, { status: 400 });

  const seeded = await wrapAsync(() => store.seed(seed), 'SEED_ERROR' as const);
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
  const subject = isObject(body) && isString(body.subject) ? body.subject : undefined;
  store.reset(subject);
  return NextResponse.json({ reset: subject ?? 'all' });
}
