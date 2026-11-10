/**
 * One person's notification feed through its route (GET/POST/DELETE
 * /api/notifications), on the memory store. These were notifications.spec.ts's
 * and chat-notifications.spec.ts's server answers: the feed newest first,
 * somebody else's rows never shown and never touched, "Mark all as read"
 * reaching rows past the page, "Show more" paging backward, and a delete
 * that sticks.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { DELETE, GET, POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const ME = 'alice';
const SOMEBODY_ELSE = 'bob';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
});

afterEach(() => resetDataStore());

/** `count` rows for `subject`, the first the newest, a minute apart. */
async function seed(subject: string, count: number, prefix = subject): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${String(index).padStart(3, '0')}`;
    await getDataStore().notifications.insert({
      id,
      subject,
      kind: 'agent_shared',
      category: null,
      connector: null,
      tool: null,
      entity: null,
      headline: `Shared ${id}`,
      refUrl: null,
      agentId: null,
      agentName: null,
      runId: null,
      meta: null,
      createdAt: new Date(Date.UTC(2026, 9, 30, 12, 0) - index * 60_000),
    });
    ids.push(id);
  }
  return ids;
}

const url = (query = '') => `http://test.local/api/notifications${query}`;
const get = async (query = '') => {
  const response = await GET(new NextRequest(url(query)));
  return { status: response.status, body: await response.json() };
};
const send = (method: 'POST' | 'DELETE', body: unknown) =>
  new NextRequest(url(), { method, body: JSON.stringify(body) });

const ids = (body: { notifications: { id: string }[] }) => body.notifications.map((row) => row.id);

it('answers 401 to somebody not signed in', async () => {
  mockGetSession.mockResolvedValue(null);
  expect((await get()).status).toBe(401);
  expect((await POST(send('POST', { all: true }))).status).toBe(401);
  expect((await DELETE(send('DELETE', { all: true }))).status).toBe(401);
});

it('lists the person’s feed newest first, with the unread total', async () => {
  await seed(ME, 3);
  const { status, body } = await get('?limit=100');
  expect(status).toBe(200);
  expect(ids(body)).toEqual(['alice-000', 'alice-001', 'alice-002']);
  expect(body.unread).toBe(3);
});

it('never shows somebody else’s notifications, and a person with none sees none', async () => {
  await seed(SOMEBODY_ELSE, 2);
  const { body } = await get('?limit=100');
  expect(body.notifications).toEqual([]);
  expect(body.unread).toBe(0);
});

it('marks one read and back to unread', async () => {
  await seed(ME, 3);
  await POST(send('POST', { ids: ['alice-002'] }));
  expect((await get()).body.unread).toBe(2);
  await POST(send('POST', { ids: ['alice-002'], unread: true }));
  expect((await get()).body.unread).toBe(3);
});

it('"Mark all as read" reaches rows past the page the feed shows', async () => {
  await seed(ME, 105);
  const response = await POST(send('POST', { all: true }));
  expect(response.status).toBe(200);
  expect((await response.json()).marked).toBe(105);
  const { body } = await get('?limit=100');
  expect(body.unread).toBe(0);
  expect(body.notifications.every((row: { readAt: string | null }) => row.readAt !== null)).toBe(
    true
  );
});

it('marking all, or a borrowed id, leaves somebody else’s rows unread', async () => {
  const theirs = await seed(SOMEBODY_ELSE, 2);
  await seed(ME, 1);
  await POST(send('POST', { all: true }));
  await POST(send('POST', { ids: theirs }));
  expect(await getDataStore().notifications.countUnread(SOMEBODY_ELSE)).toBe(2);
});

it('"Show more" pages backward from the oldest row, without repeats', async () => {
  await seed(ME, 105);
  const first = await get('?limit=100');
  expect(first.body.notifications).toHaveLength(100);
  const oldest = first.body.notifications[99].createdAt;
  const more = await get(`?limit=100&before=${encodeURIComponent(oldest)}`);
  expect(ids(more.body)).toEqual(['alice-100', 'alice-101', 'alice-102', 'alice-103', 'alice-104']);
});

it('caps a page at 100 rows', async () => {
  await seed(ME, 105);
  expect((await get('?limit=500')).body.notifications).toHaveLength(100);
});

it('a delete sticks, and a borrowed id deletes nothing', async () => {
  await seed(ME, 3);
  const theirs = await seed(SOMEBODY_ELSE, 1);
  const response = await DELETE(send('DELETE', { ids: ['alice-000', 'alice-002', ...theirs] }));
  expect((await response.json()).deleted).toBe(2);
  expect(ids((await get()).body)).toEqual(['alice-001']);
  mockGetSession.mockResolvedValue({ subject: SOMEBODY_ELSE, roles: ['renkei-user'] });
  expect(ids((await get()).body)).toEqual(theirs);
});

it('refuses a body that names neither ids nor all', async () => {
  expect((await POST(send('POST', { unread: true }))).status).toBe(400);
  expect((await POST(send('POST', []))).status).toBe(400);
  expect((await DELETE(send('DELETE', { ids: 'alice-000' }))).status).toBe(400);
});
