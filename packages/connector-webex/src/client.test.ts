/**
 * `sendNoteToSelf`'s room-finding: an existing solo room wins over
 * creating a new one, a 1:1-only account gets a fresh "Note to Self"
 * room, and a failure at any step surfaces rather than posting nowhere.
 */

import { WebexClient, webexNextPagePath } from './client';

function jsonResponse(body: unknown, status = 200, next?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(next ? { Link: `<https://webexapis.com/v1${next}>; rel="next"` } : {}),
    },
  });
}

describe('webexNextPagePath', () => {
  it('returns the rel="next" url relative to the API base', () => {
    expect(
      webexNextPagePath(
        '<https://webexapis.com/v1/rooms?cursor=abc&max=100>; rel="next", ' +
          '<https://webexapis.com/v1/rooms?cursor=xyz>; rel="prev"'
      )
    ).toBe('/rooms?cursor=abc&max=100');
  });

  it('is null with no header, no next link, or a link off the API base', () => {
    expect(webexNextPagePath(null)).toBeNull();
    expect(webexNextPagePath('<https://webexapis.com/v1/rooms?cursor=x>; rel="prev"')).toBeNull();
    expect(webexNextPagePath('<https://evil.example/rooms?cursor=x>; rel="next"')).toBeNull();
  });
});

describe('WebexClient.listRooms', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const roomsNamed = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ id: `room-${from + i}`, title: 'x' }));

  it('asks for one page no larger than WebEx serves, most recently active first', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: roomsNamed(1, 3) }));
    const client = new WebexClient('token');

    await client.listRooms(30);
    await client.listRooms(400);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://webexapis.com/v1/rooms?max=30&sortBy=lastactivity'
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://webexapis.com/v1/rooms?max=100&sortBy=lastactivity'
    );
  });

  it('follows Link rel="next" until max is reached, then stops asking', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: roomsNamed(1, 100) }, 200, '/rooms?cursor=p2'))
      .mockResolvedValueOnce(jsonResponse({ items: roomsNamed(101, 200) }, 200, '/rooms?cursor=p3'))
      .mockResolvedValueOnce(
        jsonResponse({ items: roomsNamed(201, 300) }, 200, '/rooms?cursor=p4')
      );

    const result = await new WebexClient('token').listRooms(250);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val).toHaveLength(250);
    expect(result.val[0].id).toBe('room-1');
    expect(result.val[249].id).toBe('room-250');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://webexapis.com/v1/rooms?cursor=p2');
  });

  it('stops at the last page when there are fewer rooms than max', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: roomsNamed(1, 100) }, 200, '/rooms?cursor=p2'))
      .mockResolvedValueOnce(jsonResponse({ items: roomsNamed(101, 120) }));

    const result = await new WebexClient('token').listRooms(400);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val).toHaveLength(120);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails the whole call when a later page fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: roomsNamed(1, 100) }, 200, '/rooms?cursor=p2'))
      .mockResolvedValueOnce(jsonResponse({ message: 'slow down' }, 429));

    const result = await new WebexClient('token').listRooms(400);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err.message).toContain('429');
  });
});

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
        return Promise.resolve(jsonResponse({ items: [{ id: 'room-1', title: 'Note to Self' }] }));
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
