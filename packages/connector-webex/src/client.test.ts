/**
 * `sendNoteToSelf`'s room-finding: an existing solo room wins over
 * creating a new one, a 1:1-only account gets a fresh "Note to Self"
 * room, and a failure at any step surfaces rather than posting nowhere.
 */

import { WebexClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WebexClient.sendNoteToSelf', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('posts into an existing solo room without creating one', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('/rooms?')) {
        return Promise.resolve(
          jsonResponse({ items: [{ id: 'room-1', title: 'Note to Self' }] })
        );
      }
      if (url.includes('/memberships?')) {
        return Promise.resolve(jsonResponse({ items: [{ id: 'me' }] }));
      }
      if (url.endsWith('/messages')) {
        return Promise.resolve(jsonResponse({ id: 'msg-1' }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = new WebexClient('token');
    const result = await client.sendNoteToSelf('**Hi**');

    expect(result).toEqual({ ok: true, val: { id: 'msg-1', roomId: 'room-1' } });
    // No POST /rooms — the existing solo room was reused.
    const posted = fetchMock.mock.calls.map(([input]) => String(input));
    expect(posted.some((url) => url.endsWith('/rooms'))).toBe(false);
  });

  it('creates a "Note to Self" room when every candidate has more than one member', async () => {
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rooms?')) {
        return Promise.resolve(jsonResponse({ items: [{ id: 'room-crowded', title: 'Team' }] }));
      }
      if (url.includes('/memberships?')) {
        return Promise.resolve(jsonResponse({ items: [{ id: 'me' }, { id: 'them' }] }));
      }
      if (url.endsWith('/rooms') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'room-new' }));
      }
      if (url.endsWith('/messages')) {
        return Promise.resolve(jsonResponse({ id: 'msg-2' }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = new WebexClient('token');
    const result = await client.sendNoteToSelf('Digest');

    expect(result).toEqual({ ok: true, val: { id: 'msg-2', roomId: 'room-new' } });
    const createRoomCall = fetchMock.mock.calls.find((call): call is [unknown, RequestInit] => {
      const [input, init] = call;
      return String(input).endsWith('/rooms') && init?.method === 'POST';
    });
    expect(createRoomCall).toBeDefined();
    expect(JSON.parse(String(createRoomCall?.[1].body))).toEqual({
      title: 'Note to Self',
    });
  });

  it('surfaces a failure instead of posting nowhere', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('/rooms?')) return Promise.resolve(jsonResponse({}, 500));
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = new WebexClient('token');
    const result = await client.sendNoteToSelf('Hi');
    expect(result.ok).toBe(false);
  });
});
