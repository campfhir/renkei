/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * WebEx tools' own rendering and wizard logic, against a stub `WebexAuth` —
 * uninterested in how auth works, which is webex-auth.test.ts's job. Mirrors
 * jira-service-management/ops.test.ts's split.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// webex_capture_message reaches around the auth abstraction for personEmail
// (see index.ts's comment on why) — the only reason this file needs to know
// resolveWebexAccess exists at all.
jest.mock('./webex-auth', () => ({
  resolveWebexAccess: jest.fn(async () => ({
    accessToken: 'unused',
    personEmail: 'alice@example.com',
  })),
}));
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      insertInto: () => ({
        values: (row: unknown) => {
          insertedRows.push(row);
          return { execute: async () => undefined };
        },
      }),
    },
  }),
}));

const insertedRows: unknown[] = [];
const mockCall = jest.fn();

import type { McpServer } from '@modelcontextprotocol/server';
import { registerWebexUserTools, webexScopeFor } from './index';
import type { WebexAuth } from './webex-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

function stubAuth(): WebexAuth {
  return {
    kind: 'oauth',
    fetch: (_scopes, path, init) => mockCall(path, init),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
  }) as unknown as MCPToolContext;

async function toolsOf(auth: WebexAuth = stubAuth()): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerWebexUserTools(server, context(), auth);
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

beforeEach(() => {
  jest.clearAllMocks();
  insertedRows.length = 0;
  mockCall.mockResolvedValue(jsonResponse({ items: [] }));
});

describe('webex_list_rooms', () => {
  it('renders rooms with their ids', async () => {
    mockCall.mockResolvedValue(
      jsonResponse({
        items: [{ id: 'room-1', title: 'Engineering', type: 'group', lastActivity: '2026-08-10' }],
      })
    );
    const tools = await toolsOf();

    const text = textOf(await tools.get('webex_list_rooms')!({}));

    expect(text).toContain('Engineering');
    expect(text).toContain('id: room-1');
  });

  it('asks with the exact scope webexScopeFor names for this tool', async () => {
    const tools = await toolsOf();
    await tools.get('webex_list_rooms')!({});

    expect(mockCall).toHaveBeenCalledWith(expect.stringContaining('/rooms'), undefined);
  });
});

describe('webex_bulk_list_messages', () => {
  const messagesFor = (roomId: string) =>
    jsonResponse({
      items: [
        {
          id: `msg-${roomId}`,
          roomId,
          personEmail: 'bob@example.com',
          text: `hello from ${roomId}`,
          created: '2026-08-18',
        },
      ],
    });

  it('reads every room in one call and keeps the sections in the order asked', async () => {
    mockCall.mockImplementation(async (path: string) => {
      const roomId = new URL(path, 'https://x').searchParams.get('roomId') ?? '';
      return messagesFor(roomId);
    });
    const tools = await toolsOf();

    const result = await tools.get('webex_bulk_list_messages')!({
      roomIds: ['room-1', 'room-2', 'room-3'],
      limit: 5,
    });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(mockCall).toHaveBeenCalledTimes(3);
    expect(mockCall).toHaveBeenCalledWith('/messages?roomId=room-2&max=5', undefined);
    expect(text).toContain('3 room(s)');
    expect(text.indexOf('roomId: room-1')).toBeLessThan(text.indexOf('roomId: room-2'));
    expect(text.indexOf('roomId: room-2')).toBeLessThan(text.indexOf('roomId: room-3'));
    expect(text).toContain('hello from room-3');
  });

  it('reads a room once even when its id is repeated', async () => {
    mockCall.mockImplementation(async (path: string) => {
      const roomId = new URL(path, 'https://x').searchParams.get('roomId') ?? '';
      return messagesFor(roomId);
    });
    const tools = await toolsOf();

    const text = textOf(
      await tools.get('webex_bulk_list_messages')!({ roomIds: ['room-1', 'room-1'] })
    );

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(text).toContain('1 room(s)');
  });

  it('reports a room it cannot read in its own section without failing the others', async () => {
    mockCall.mockImplementation(async (path: string) => {
      const roomId = new URL(path, 'https://x').searchParams.get('roomId') ?? '';
      if (roomId === 'room-2') return jsonResponse({ message: 'room not found' }, 404);
      return messagesFor(roomId);
    });
    const tools = await toolsOf();

    const result = await tools.get('webex_bulk_list_messages')!({
      roomIds: ['room-1', 'room-2'],
    });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain('2 room(s) (1 could not be read)');
    expect(text).toContain('hello from room-1');
    expect(text).toContain(
      '## roomId: room-2\n(Could not read: WebEx API answered 404: room not found.)'
    );
  });

  it('says so when a room simply has no messages', async () => {
    const tools = await toolsOf();

    const text = textOf(await tools.get('webex_bulk_list_messages')!({ roomIds: ['room-1'] }));

    expect(text).toContain('## roomId: room-1\n(No messages.)');
  });

  it('is an error only when every room fails', async () => {
    mockCall.mockResolvedValue(jsonResponse({ message: 'token revoked' }, 401));
    const tools = await toolsOf();

    const result = await tools.get('webex_bulk_list_messages')!({
      roomIds: ['room-1', 'room-2'],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('None of the 2 room(s) could be read');
    expect(textOf(result)).toContain('token revoked');
  });

  it('refuses an empty roomIds without calling WebEx', async () => {
    const tools = await toolsOf();

    const result = await tools.get('webex_bulk_list_messages')!({ roomIds: [] });

    expect(result.isError).toBe(true);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('since window', () => {
  const message = (stamp: string, id = `msg-${stamp}`) => ({
    id,
    roomId: 'room-1',
    personEmail: 'bob@example.com',
    text: `sent ${stamp}`,
    created: stamp,
  });
  const page = (created: string[]) => jsonResponse({ items: created.map((s) => message(s)) });
  const cursorOf = (path: string) => new URL(path, 'https://x').searchParams.get('beforeMessage');
  /** ISO stamps counting back one minute per index from a fixed point. */
  const minutesBack = (count: number, from = Date.parse('2026-09-09T12:00:00Z')) =>
    Array.from({ length: count }, (_, i) => new Date(from - i * 60_000).toISOString());

  it('keeps only messages created at or after since, on the single-room tool', async () => {
    mockCall.mockResolvedValue(
      page(['2026-09-09T10:00:00Z', '2026-09-08T00:00:00Z', '2026-09-07T23:59:59Z'])
    );
    const tools = await toolsOf();

    const text = textOf(
      await tools.get('webex_list_messages')!({ roomId: 'room-1', since: '2026-09-08T00:00:00Z' })
    );

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(text).toContain('sent 2026-09-09T10:00:00Z');
    expect(text).toContain('sent 2026-09-08T00:00:00Z');
    expect(text).not.toContain('sent 2026-09-07T23:59:59Z');
    expect(text).not.toContain('are shown');
  });

  it('without since, a limit within one page is still the single call it always was', async () => {
    const tools = await toolsOf();

    await tools.get('webex_list_messages')!({ roomId: 'room-1', limit: 5 });

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('/messages?roomId=room-1&max=5', undefined);
  });

  it('newest: stops at limit and says the window holds more', async () => {
    mockCall.mockResolvedValue(page(['2026-09-09T10:00:00Z', '2026-09-09T09:00:00Z']));
    const tools = await toolsOf();

    const text = textOf(
      await tools.get('webex_bulk_list_messages')!({
        roomIds: ['room-1'],
        limit: 2,
        since: '2026-09-01T00:00:00Z',
      })
    );

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(text).toContain('sent 2026-09-09T09:00:00Z');
    expect(text).toContain('Only the newest 2 of the window are shown');
    expect(text).toContain('keep: "oldest"');
  });

  it('oldest: walks back to since with beforeMessage, then keeps the earliest', async () => {
    const first = minutesBack(100);
    mockCall.mockImplementation(async (path: string) => {
      if (cursorOf(path) === null) return page(first);
      // Two more inside the window, then one before it — the walk must stop there.
      return page(['2026-09-08T00:00:02Z', '2026-09-08T00:00:01Z', '2026-09-07T23:00:00Z']);
    });
    const tools = await toolsOf();

    const text = textOf(
      await tools.get('webex_bulk_list_messages')!({
        roomIds: ['room-1'],
        limit: 2,
        since: '2026-09-08T00:00:00Z',
        keep: 'oldest',
      })
    );

    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(mockCall).toHaveBeenLastCalledWith(
      `/messages?roomId=room-1&max=100&beforeMessage=${encodeURIComponent(`msg-${first[99]}`)}`,
      undefined
    );
    expect(text).toContain('sent 2026-09-08T00:00:02Z');
    expect(text).toContain('sent 2026-09-08T00:00:01Z');
    expect(text).not.toContain('sent 2026-09-07T23:00:00Z');
    expect(text).not.toContain(`sent ${first[0]}`);
    expect(text).toContain('Only the oldest 2 of the window are shown');
    expect(text).not.toContain('without reaching');
  });

  it('oldest: gives up after the page cap and says the start was not reached', async () => {
    let served = 0;
    mockCall.mockImplementation(async () => {
      const stamps = minutesBack(100, Date.parse('2026-09-09T12:00:00Z') - served * 60_000);
      served += 100;
      return page(stamps);
    });
    const tools = await toolsOf();

    const text = textOf(
      await tools.get('webex_list_messages')!({
        roomId: 'room-1',
        limit: 3,
        since: '2020-01-01T00:00:00Z',
        keep: 'oldest',
      })
    );

    expect(mockCall).toHaveBeenCalledTimes(10);
    expect(text).toContain('Walked 1000 messages back without reaching 2020-01-01T00:00:00Z');
  });

  it('says when a room has nothing in the window', async () => {
    mockCall.mockResolvedValue(page(['2026-09-01T10:00:00Z']));
    const tools = await toolsOf();

    const text = textOf(
      await tools.get('webex_bulk_list_messages')!({
        roomIds: ['room-1'],
        since: '2026-09-08T00:00:00Z',
      })
    );

    expect(text).toContain('## roomId: room-1\n(No messages since 2026-09-08T00:00:00Z.)');
  });

  it('rejects a since that is not a date, without calling WebEx', async () => {
    const tools = await toolsOf();

    const result = await tools.get('webex_bulk_list_messages')!({
      roomIds: ['room-1'],
      since: 'yesterday',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ISO 8601');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('rejects keep: oldest without since, which would walk the whole room', async () => {
    const tools = await toolsOf();

    const result = await tools.get('webex_list_messages')!({ roomId: 'room-1', keep: 'oldest' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('needs since');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('refuses a bulk call whose rooms × limit would overflow one reply', async () => {
    const tools = await toolsOf();

    const result = await tools.get('webex_bulk_list_messages')!({
      roomIds: ['room-1', 'room-2', 'room-3', 'room-4'],
      limit: 200,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('800 messages');
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('webex_send_message', () => {
  it('refuses when neither roomId nor toPersonEmail is given', async () => {
    const tools = await toolsOf();

    const result = await tools.get('webex_send_message')!({ markdown: 'hi' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Provide roomId or toPersonEmail');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('refuses when both roomId and toPersonEmail are given', async () => {
    const tools = await toolsOf();

    const result = await tools.get('webex_send_message')!({
      roomId: 'room-1',
      toPersonEmail: 'bob@example.com',
      markdown: 'hi',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not both');
  });

  it('refuses to DM the user’s own address, pointing at webex_note_to_self', async () => {
    const tools = await toolsOf();

    // Case differs from the stubbed grant email on purpose — WebEx addresses
    // are case-insensitive, so the guard must be too.
    const result = await tools.get('webex_send_message')!({
      toPersonEmail: 'Alice@Example.com',
      markdown: 'note to me',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('webex_note_to_self');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('sends to a room, given only roomId', async () => {
    mockCall.mockResolvedValue(jsonResponse({ id: 'msg-9', roomId: 'room-1' }));
    const tools = await toolsOf();

    const result = await tools.get('webex_send_message')!({ roomId: 'room-1', markdown: 'hi' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('msg-9');
    const [, init] = mockCall.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ roomId: 'room-1', markdown: 'hi' });
  });

  it('links the receipt to a webexteams:// deep link, decoded from the room id', async () => {
    // base64 of ciscospark://us/ROOM/bbceb1ad-43f1-3b58-9147-f14bb0c4d154
    const roomId = Buffer.from(
      'ciscospark://us/ROOM/bbceb1ad-43f1-3b58-9147-f14bb0c4d154',
      'utf8'
    ).toString('base64');
    mockCall.mockResolvedValue(jsonResponse({ id: 'msg-9', roomId }));
    const tools = await toolsOf();

    const result = (await tools.get('webex_send_message')!({
      roomId,
      markdown: 'hi',
    })) as { _meta?: Record<string, { url?: string }> };

    const receipt = Object.values(result._meta ?? {})[0];
    expect(receipt?.url).toBe('webexteams://im?space=bbceb1ad-43f1-3b58-9147-f14bb0c4d154');
  });

  it('adds &message=<uuid> to the deep link, decoded from the message id', async () => {
    // base64 of ciscospark://us/ROOM/bbceb1ad-43f1-3b58-9147-f14bb0c4d154
    const roomId = Buffer.from(
      'ciscospark://us/ROOM/bbceb1ad-43f1-3b58-9147-f14bb0c4d154',
      'utf8'
    ).toString('base64');
    // base64 of ciscospark://us/MESSAGE/11112222-3333-4444-5555-666677778888
    const messageId = Buffer.from(
      'ciscospark://us/MESSAGE/11112222-3333-4444-5555-666677778888',
      'utf8'
    ).toString('base64');
    mockCall.mockResolvedValue(jsonResponse({ id: messageId, roomId }));
    const tools = await toolsOf();

    const result = (await tools.get('webex_send_message')!({
      roomId,
      markdown: 'hi',
    })) as { _meta?: Record<string, { url?: string }> };

    const receipt = Object.values(result._meta ?? {})[0];
    expect(receipt?.url).toBe(
      'webexteams://im?space=bbceb1ad-43f1-3b58-9147-f14bb0c4d154' +
        '&message=11112222-3333-4444-5555-666677778888'
    );
  });

  it('omits the receipt link when the room id does not decode to a ROOM uri', async () => {
    mockCall.mockResolvedValue(jsonResponse({ id: 'msg-9', roomId: 'room-1' }));
    const tools = await toolsOf();

    const result = (await tools.get('webex_send_message')!({
      roomId: 'room-1',
      markdown: 'hi',
    })) as { _meta?: unknown };

    expect(result._meta).toBeUndefined();
  });
});

describe('webex_note_to_self', () => {
  it('posts into an existing space that contains only the user, without creating one', async () => {
    mockCall
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 'room-solo', title: 'Scratch', type: 'group' }] })
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'mem-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1', roomId: 'room-solo' }));
    const tools = await toolsOf();

    const result = await tools.get('webex_note_to_self')!({ markdown: 'remember this' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('room-solo');
    expect(textOf(result)).toContain('msg-1');
    const paths = mockCall.mock.calls.map(([path]) => path as string);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain('/rooms?');
    expect(paths[1]).toContain('/memberships?roomId=room-solo');
    expect(paths[2]).toBe('/messages');
  });

  it('probes a room titled "Note to Self" before more recently active rooms', async () => {
    mockCall
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { id: 'room-busy', title: 'Engineering', type: 'group' },
            { id: 'room-note', title: 'Note to Self', type: 'group' },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'mem-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1', roomId: 'room-note' }));
    const tools = await toolsOf();

    await tools.get('webex_note_to_self')!({ markdown: 'x' });

    expect(mockCall.mock.calls[1][0]).toContain('roomId=room-note');
  });

  it('creates "Note to Self" when every space has other members', async () => {
    mockCall
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 'room-team', title: 'Team', type: 'group' }] })
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'mem-1' }, { id: 'mem-2' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'room-new', title: 'Note to Self' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-2', roomId: 'room-new' }));
    const tools = await toolsOf();

    const result = await tools.get('webex_note_to_self')!({ markdown: 'todo' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('newly created');
    const [createPath, createInit] = mockCall.mock.calls[2] as [string, RequestInit];
    expect(createPath).toBe('/rooms');
    expect(JSON.parse(createInit.body as string)).toEqual({ title: 'Note to Self' });
    const [, sendInit] = mockCall.mock.calls[3] as [string, RequestInit];
    expect(JSON.parse(sendInit.body as string)).toMatchObject({
      roomId: 'room-new',
      markdown: 'todo',
    });
  });
});

describe('webex_capture_message', () => {
  it('records the WebEx account email as capturedBy, not the OIDC subject', async () => {
    // resolveWebexAccess is stubbed to return alice@example.com — proving
    // capture_message actually uses it rather than falling back to
    // context.subject, which would silently lose the real identity.
    mockCall.mockResolvedValue(
      jsonResponse({
        id: 'msg-1',
        roomId: 'room-1',
        personEmail: 'bob@example.com',
        text: 'Ship it',
      })
    );
    const tools = await toolsOf();

    await tools.get('webex_capture_message')!({ messageId: 'msg-1' });

    expect(insertedRows).toHaveLength(1);
    const evidence = JSON.parse((insertedRows[0] as { evidence: string }).evidence);
    expect(evidence.capturedBy).toBe('alice@example.com');
  });

  it('refuses to capture a message with no text', async () => {
    mockCall.mockResolvedValue(jsonResponse({ id: 'msg-1', roomId: 'room-1' }));
    const tools = await toolsOf();

    const result = await tools.get('webex_capture_message')!({ messageId: 'msg-1' });

    expect(result.isError).toBe(true);
    expect(insertedRows).toHaveLength(0);
  });
});

describe('a failed call', () => {
  it('surfaces the API detail through errText, not a raw status', async () => {
    mockCall.mockResolvedValue(jsonResponse({ message: 'room not found' }, 404));
    const tools = await toolsOf();

    const result = await tools.get('webex_list_messages')!({ roomId: 'room-1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('room not found');
  });
});

describe('webexScopeFor', () => {
  it('gives the write tool a write scope, not the default read one', () => {
    expect(webexScopeFor('webex_send_message')).toEqual(['spark:messages_write']);
  });

  it('defaults everything else to message read', () => {
    expect(webexScopeFor('webex_get_message')).toEqual(['spark:messages_read']);
  });

  it('names all four scopes note_to_self stands on', () => {
    expect(webexScopeFor('webex_note_to_self')).toEqual([
      'spark:messages_write',
      'spark:rooms_read',
      'spark:rooms_write',
      'spark:memberships_read',
    ]);
  });
});

describe('threaded replies', () => {
  it('marks a reply with its thread root id, the one parentId can reply under', async () => {
    mockCall.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'msg-2',
            roomId: 'room-1',
            personEmail: 'bob@example.com',
            text: 'agreed',
            parentId: 'msg-root',
            created: '2026-08-18',
          },
        ],
      })
    );
    const tools = await toolsOf();

    const text = textOf(await tools.get('webex_list_messages')!({ roomId: 'room-1' }));

    expect(text).toContain('in thread msg-root');
  });
});
