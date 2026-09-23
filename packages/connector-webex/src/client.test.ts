/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `sendNoteToSelf`'s room-finding: an existing solo room wins over
 * creating a new one, a 1:1-only account gets a fresh "Note to Self"
 * room, and a failure at any step surfaces rather than posting nowhere.
 */

import { WebexClient, sendNoteToPerson, webexNextPagePath } from './client';

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

  it('carries a file into the solo room as multipart, not JSON', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('/rooms?')) {
        return Promise.resolve(jsonResponse({ items: [{ id: 'room-1', title: 'Note to Self' }] }));
      }
      if (url.includes('/memberships?')) {
        return Promise.resolve(jsonResponse({ items: [{ id: 'me' }] }));
      }
      if (url.endsWith('/messages')) {
        return Promise.resolve(jsonResponse({ id: 'msg-3' }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = new WebexClient('token');
    const result = await client.sendNoteToSelf('Digest', {
      filename: 'report.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(result).toEqual({ ok: true, val: { id: 'msg-3', roomId: 'room-1' } });
    const send = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/messages')) as
      | [unknown, RequestInit]
      | undefined;
    expect(send?.[1].body).toBeInstanceOf(FormData);
    const form = send?.[1].body as FormData;
    expect(form.get('roomId')).toBe('room-1');
    expect(form.get('markdown')).toBe('Digest');
    expect((form.get('files') as File).name).toBe('report.pdf');
  });
});

describe('sendNoteToPerson', () => {
  const user = { sendNoteToSelf: jest.fn() };
  const bot = { postMessage: jest.fn() };

  beforeEach(() => {
    user.sendNoteToSelf.mockReset();
    bot.postMessage.mockReset();
    user.sendNoteToSelf.mockResolvedValue({
      ok: true,
      val: { id: 'msg-self', roomId: 'room-solo' },
    });
    bot.postMessage.mockResolvedValue({ ok: true, val: { id: 'msg-bot', roomId: 'room-dm' } });
  });

  it('sends a direct message from the bot when there is one and the address is known', async () => {
    const result = await sendNoteToPerson({
      bot,
      user,
      personEmail: 'alice@example.com',
      markdown: '**Hi**',
    });

    expect(result).toEqual({ ok: true, val: { id: 'msg-bot', roomId: 'room-dm', via: 'bot' } });
    expect(bot.postMessage).toHaveBeenCalledWith({
      toPersonEmail: 'alice@example.com',
      markdown: '**Hi**',
    });
    expect(user.sendNoteToSelf).not.toHaveBeenCalled();
  });

  it('posts into the solo space when no bot is configured', async () => {
    const result = await sendNoteToPerson({
      bot: null,
      user,
      personEmail: 'alice@example.com',
      markdown: 'Digest',
    });

    expect(result).toEqual({ ok: true, val: { id: 'msg-self', roomId: 'room-solo', via: 'self' } });
    expect(user.sendNoteToSelf).toHaveBeenCalledWith('Digest');
  });

  it('posts into the solo space when the address is unknown, without asking the bot', async () => {
    const result = await sendNoteToPerson({ bot, user, personEmail: null, markdown: 'x' });

    expect(result.ok && result.val.via).toBe('self');
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to the solo space when the bot cannot deliver', async () => {
    bot.postMessage.mockResolvedValue({ ok: false, err: 'WEBEX_API_ERROR' });

    const result = await sendNoteToPerson({
      bot,
      user,
      personEmail: 'alice@example.com',
      markdown: 'x',
    });

    expect(result.ok && result.val.via).toBe('self');
    expect(user.sendNoteToSelf).toHaveBeenCalledTimes(1);
  });

  it('surfaces the solo-space failure when neither route delivered', async () => {
    bot.postMessage.mockResolvedValue({ ok: false, err: 'WEBEX_API_ERROR' });
    user.sendNoteToSelf.mockResolvedValue({ ok: false, err: 'WEBEX_API_ERROR' });

    const result = await sendNoteToPerson({
      bot,
      user,
      personEmail: 'alice@example.com',
      markdown: 'x',
    });

    expect(result.ok).toBe(false);
  });
});

describe('WebexClient.postMessage', () => {
  it('answers with the room a 1:1 send landed in', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'msg-1', roomId: 'room-dm' }));
    try {
      const result = await new WebexClient('bot-token').postMessage({
        toPersonEmail: 'alice@example.com',
        markdown: 'Hi',
      });
      expect(result).toEqual({ ok: true, val: { id: 'msg-1', roomId: 'room-dm' } });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        toPersonEmail: 'alice@example.com',
        markdown: 'Hi',
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('posts multipart/form-data when the message carries a file, never JSON', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'msg-2', roomId: 'room-1' }));
    try {
      const result = await new WebexClient('bot-token').postMessage({
        roomId: 'room-1',
        markdown: 'see attached',
        file: { filename: 'notes.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('hi') },
      });

      expect(result).toEqual({ ok: true, val: { id: 'msg-2', roomId: 'room-1' } });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
      const form = init.body as FormData;
      expect(form.get('roomId')).toBe('room-1');
      expect(form.get('markdown')).toBe('see attached');
      const file = form.get('files') as File;
      expect(file.name).toBe('notes.txt');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
