/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * WebEx unread derivation.
 *
 * There is no unread flag in WebEx, so this is computed from each
 * membership's lastSeenId. That makes it the part most able to be quietly
 * wrong — a brief claiming "12 unread" for messages already read is worse
 * than one that says nothing — so the cursor semantics are pinned here.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn(() => ({ ok: false })) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../webex/webex-auth', () => ({
  resolveWebexAccess: jest.fn(async () => ({
    accessToken: 'token',
    personEmail: 'alice@example.com',
  })),
}));

import { collectWebex } from './collect-webex';
import { resolvePeriod } from './period';
import type { MCPToolContext } from '../common';

const context = () => ({}) as unknown as MCPToolContext;
const period = () =>
  resolvePeriod({ period: 'today', timeZone: 'UTC' }, new Date('2026-08-12T12:00:00Z'));

interface Route {
  match: string;
  items: unknown[];
}

let routes: Route[] = [];
let requested: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  requested = [];
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    const route = routes.find((candidate) => url.includes(candidate.match));
    return new Response(JSON.stringify({ items: route?.items ?? [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const message = (id: string, text: string) => ({
  id,
  text,
  personEmail: 'sam@example.com',
  created: '2026-08-12T09:00:00.000Z',
});

describe('collectWebex', () => {
  it('counts only messages after the read cursor', async () => {
    routes = [
      {
        match: '/rooms',
        items: [{ id: 'room-1', title: 'Eng', lastActivity: '2026-08-12T10:00:00Z' }],
      },
      { match: '/memberships', items: [{ roomId: 'room-1', lastSeenId: 'm-3' }] },
      // Newest first, as WebEx returns them.
      {
        match: '/messages',
        items: [
          message('m-5', 'newest'),
          message('m-4', 'also new'),
          message('m-3', 'already read'),
          message('m-2', 'older'),
        ],
      },
    ];

    const section = await collectWebex(context(), period());

    expect(section?.headline).toContain('2 messages');
    expect(section?.detail).toContain('newest');
    expect(section?.detail).toContain('also new');
    // Everything at or before the cursor has been seen.
    expect(section?.detail).not.toContain('already read');
    expect(section?.detail).not.toContain('older');
  });

  it('fetches memberships once, not once per room', async () => {
    routes = [
      {
        match: '/rooms',
        items: [
          { id: 'room-1', title: 'A', lastActivity: '2026-08-12T10:00:00Z' },
          { id: 'room-2', title: 'B', lastActivity: '2026-08-12T10:00:00Z' },
          { id: 'room-3', title: 'C', lastActivity: '2026-08-12T10:00:00Z' },
        ],
      },
      { match: '/memberships', items: [{ roomId: 'room-1', lastSeenId: 'm-0' }] },
      { match: '/messages', items: [message('m-1', 'hello')] },
    ];

    await collectWebex(context(), period());

    const membershipCalls = requested.filter((url) => url.includes('/memberships'));
    expect(membershipCalls).toHaveLength(1);
    // And it asks for all of them rather than filtering to one room.
    expect(membershipCalls[0]).not.toContain('roomId=');
  });

  it('treats a room with no membership cursor as entirely unread', async () => {
    // No lastSeenId means the person has never opened it; everything in the
    // window is genuinely new to them.
    routes = [
      {
        match: '/rooms',
        items: [{ id: 'room-9', title: 'New space', lastActivity: '2026-08-12T10:00:00Z' }],
      },
      { match: '/memberships', items: [] },
      { match: '/messages', items: [message('m-1', 'first'), message('m-2', 'second')] },
    ];

    const section = await collectWebex(context(), period());
    expect(section?.headline).toContain('2 messages');
  });

  it('excludes messages outside the period even when unread', async () => {
    routes = [
      {
        match: '/rooms',
        items: [{ id: 'room-1', title: 'Eng', lastActivity: '2026-08-12T10:00:00Z' }],
      },
      { match: '/memberships', items: [] },
      {
        match: '/messages',
        items: [
          message('m-2', 'today'),
          { ...message('m-1', 'last week'), created: '2026-08-05T09:00:00.000Z' },
        ],
      },
    ];

    const section = await collectWebex(context(), period());
    expect(section?.detail).toContain('today');
    expect(section?.detail).not.toContain('last week');
  });

  it('returns nothing when every space is caught up', async () => {
    routes = [
      {
        match: '/rooms',
        items: [{ id: 'room-1', title: 'Eng', lastActivity: '2026-08-12T10:00:00Z' }],
      },
      { match: '/memberships', items: [{ roomId: 'room-1', lastSeenId: 'm-1' }] },
      { match: '/messages', items: [message('m-1', 'read it')] },
    ];

    expect(await collectWebex(context(), period())).toBeNull();
  });

  it('renders oldest-first so a space reads as a conversation', async () => {
    routes = [
      {
        match: '/rooms',
        items: [{ id: 'room-1', title: 'Eng', lastActivity: '2026-08-12T10:00:00Z' }],
      },
      { match: '/memberships', items: [] },
      {
        match: '/messages',
        items: [message('m-2', 'second thing'), message('m-1', 'first thing')],
      },
    ];

    const section = await collectWebex(context(), period());
    const detail = section?.detail ?? '';
    expect(detail.indexOf('first thing')).toBeLessThan(detail.indexOf('second thing'));
  });
});
