/**
 * Room-day windows: the day key and ref, the transcript rendering, the
 * backwards page walk that stops at the day's start, and the rebuild
 * handler's outcomes — index the day, remove an emptied day, leave the
 * index alone when the watcher cannot read the room any more.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: jest.fn(() => 'sql-fragment') }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
  ingestObjectChunks: jest.fn(),
  deleteObjectChunks: jest.fn(),
  escapeLike: (value: string) => value,
}));
jest.mock('./webex-linked-user', () => ({ resolveWebexUserAccessBySubject: jest.fn() }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexMessage, WebexRoom } from '@renkei/connector-webex';
import type { Result } from '@campfhir/safe-functions/types';
import {
  windowDayOf,
  webexWindowRefId,
  renderWebexWindow,
  fetchWindowMessages,
  createKnowledgeIngestWebexWindowHandler,
  type WindowClient,
} from './webex-windows';
import type { ClaimedEvent } from '../queue';

const {
  resolveEmbeddingProvider: mockResolveEmbedder,
  ingestObjectChunks: mockIngest,
  deleteObjectChunks: mockDelete,
} = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
  ingestObjectChunks: jest.Mock;
  deleteObjectChunks: jest.Mock;
}>('@renkei/knowledge');

function message(
  id: string,
  created: string,
  text: string | null,
  extra: Partial<WebexMessage> = {}
): WebexMessage {
  return {
    id,
    roomId: 'room-1',
    roomType: 'group',
    text,
    personId: null,
    personEmail: 'alice@example.com',
    parentId: null,
    created,
    ...extra,
  };
}

describe('windowDayOf / webexWindowRefId', () => {
  it('keys on the UTC day and keeps the room before the first slash', () => {
    expect(windowDayOf('2026-09-02T23:30:00-02:00')).toBe('2026-09-03');
    expect(webexWindowRefId('room-1', '2026-09-03')).toBe('room-1/day/2026-09-03');
    expect(webexWindowRefId('room-1', '2026-09-03').split('/')[0]).toBe('room-1');
  });

  it('falls back to today for an unparseable timestamp', () => {
    expect(windowDayOf('nonsense')).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('renderWebexWindow', () => {
  it('renders a heading and one line per message, threaded replies marked', () => {
    const text = renderWebexWindow({ title: 'Platform', type: 'group' }, '2026-09-02', [
      message('m1', '2026-09-02T09:03:00Z', 'Printers are down'),
      message('m2', '2026-09-02T09:05:10Z', 'on it\nchecking now', {
        personEmail: 'bob@example.com',
        parentId: 'm1',
      }),
      message('m3', '2026-09-02T09:06:00Z', null),
    ]);
    expect(text).toBe(
      '# Platform — 2026-09-02\n\n' +
        '[09:03] alice@example.com: Printers are down\n' +
        '[09:05] bob@example.com: ↳ on it / checking now'
    );
  });

  it('names an untitled room by its kind', () => {
    expect(renderWebexWindow({ title: null, type: 'direct' }, '2026-09-02', [])).toContain(
      'Direct messages'
    );
  });
});

describe('fetchWindowMessages', () => {
  it('walks backwards from the day end and stops once a page crosses the day start', async () => {
    const calls: unknown[] = [];
    const client: WindowClient = {
      getRoom: async () => ok({ id: 'room-1', title: 'T', type: 'group', lastActivity: null }),
      listMessagesBefore: async (_roomId, options = {}) => {
        calls.push(options);
        if (!options.beforeMessage) {
          // A full page: the day's newest, a stray from the next day
          // (WebEx `before` is not strict), and filler down to the cut.
          return ok([
            message('m4', '2026-09-03T00:10:00Z', 'next day'),
            message('m3', '2026-09-02T22:00:00Z', 'late'),
            message('m2', '2026-09-02T10:00:00Z', 'mid'),
            ...Array.from({ length: 97 }, (_, i) =>
              message(
                `f${i}`,
                `2026-09-02T09:${String(59 - (i % 60)).padStart(2, '0')}:00Z`,
                'filler'
              )
            ),
          ]);
        }
        return ok([
          message('m1', '2026-09-02T01:00:00Z', 'early'),
          message('m0', '2026-09-01T23:00:00Z', 'yesterday'),
        ]);
      },
    };
    const result = await fetchWindowMessages(client, 'room-1', '2026-09-02');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.messages.map((m) => m.id);
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe('m1');
    expect(ids.slice(-2)).toEqual(['m2', 'm3']);
    expect(ids).not.toContain('m4');
    expect(ids).not.toContain('m0');
    expect(calls).toEqual([
      { max: 100, before: '2026-09-03T00:00:00.000Z' },
      { max: 100, beforeMessage: 'f96' },
    ]);
  });

  it('stops after a short page instead of asking for an empty one', async () => {
    let calls = 0;
    const client: WindowClient = {
      getRoom: async () => err('WEBEX_API_ERROR' as const),
      listMessagesBefore: async () => {
        calls += 1;
        return ok([message('m1', '2026-09-02T09:00:00Z', 'only')]);
      },
    };
    const result = await fetchWindowMessages(client, 'room-1', '2026-09-02');
    expect(result.ok && result.messages.map((m) => m.id)).toEqual(['m1']);
    expect(calls).toBe(1);
  });

  it('surfaces the HTTP status of a failed page', async () => {
    const client: WindowClient = {
      getRoom: async () => err('WEBEX_API_ERROR' as const),
      listMessagesBefore: async () =>
        err('WEBEX_API_ERROR' as const, { message: 'WebEx API 404 for /messages' }),
    };
    const result = await fetchWindowMessages(client, 'room-1', '2026-09-02');
    expect(result).toEqual({ ok: false, message: 'WebEx API 404 for /messages', status: 404 });
  });
});

describe('ingest.webex-window handler', () => {
  const event = (payload: Record<string, unknown>): ClaimedEvent => ({
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'knowledge:webex',
    type: 'ingest.webex-window',
    // The same round-trip the real queue's jsonb column performs.
    payload: JSON.parse(JSON.stringify(payload)),
    attempts: 1,
  });
  const payload = { provider: 'webex', roomId: 'room-1', day: '2026-09-02', subject: 'auth0|w' };

  const platform: WebexRoom = {
    id: 'room-1',
    title: 'Platform',
    type: 'group',
    lastActivity: null,
  };
  function clientWith(
    messages: WebexMessage[],
    room: Result<WebexRoom, 'WEBEX_API_ERROR'> = ok(platform)
  ): WindowClient {
    return {
      getRoom: async () => room,
      listMessagesBefore: async () => ok(messages),
    };
  }

  const resolveAccess = jest.fn(async () => ({ accessToken: 'tok', subject: 'auth0|w' }));
  const deleteLegacy = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    mockIngest.mockResolvedValue(ok({ chunks: 1, keywords: 0 }));
    mockDelete.mockResolvedValue(ok());
  });

  it('indexes the day as one transcript under the window ref, then drops legacy rows', async () => {
    const handler = createKnowledgeIngestWebexWindowHandler({
      resolveAccess,
      deleteLegacy,
      makeClient: () =>
        clientWith([
          message('m2', '2026-09-02T10:00:00Z', 'second'),
          message('m1', '2026-09-02T09:00:00Z', 'first', { personEmail: 'bob@example.com' }),
        ]),
    });
    await handler(event(payload));

    expect(mockIngest).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({
        provider: 'webex',
        refId: 'room-1/day/2026-09-02',
        content:
          '# Platform — 2026-09-02\n\n' +
          '[09:00] bob@example.com: first\n' +
          '[10:00] alice@example.com: second',
        metadata: expect.objectContaining({
          kind: 'window',
          title: 'Platform',
          day: '2026-09-02',
          participants: ['bob@example.com', 'alice@example.com'],
          messageCount: 2,
        }),
        sourceAt: '2026-09-02T10:00:00Z',
      }),
      { maxChars: 4000, overlap: 400 }
    );
    expect(deleteLegacy).toHaveBeenCalledWith('tenant-1', 'room-1', '2026-09-02');
    // Legacy rows go only AFTER the window is written.
    expect(mockIngest.mock.invocationCallOrder[0]).toBeLessThan(
      deleteLegacy.mock.invocationCallOrder[0]
    );
  });

  it('removes the window when the day has no messages left', async () => {
    const handler = createKnowledgeIngestWebexWindowHandler({
      resolveAccess,
      deleteLegacy,
      makeClient: () => clientWith([message('m1', '2026-09-02T09:00:00Z', null)]),
    });
    await handler(event(payload));
    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith('tenant-1', 'webex', 'room-1/day/2026-09-02');
    expect(deleteLegacy).toHaveBeenCalled();
  });

  it('leaves the index alone when the watcher can no longer read the room', async () => {
    const handler = createKnowledgeIngestWebexWindowHandler({
      resolveAccess,
      deleteLegacy,
      makeClient: () =>
        clientWith([], err('WEBEX_API_ERROR' as const, { message: 'WebEx API 404 for /rooms/x' })),
    });
    await handler(event(payload));
    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(deleteLegacy).not.toHaveBeenCalled();
  });

  it('throws on a transient WebEx failure so the queue retries', async () => {
    const handler = createKnowledgeIngestWebexWindowHandler({
      resolveAccess,
      deleteLegacy,
      makeClient: () =>
        clientWith([], err('WEBEX_API_ERROR' as const, { message: 'WebEx API 503 for /rooms/x' })),
    });
    await expect(handler(event(payload))).rejects.toThrow('503');
  });

  it('completes quietly when the org has no embedder or the watcher no grant', async () => {
    mockResolveEmbedder.mockResolvedValue(null);
    await createKnowledgeIngestWebexWindowHandler({ resolveAccess, deleteLegacy })(event(payload));
    expect(mockIngest).not.toHaveBeenCalled();

    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    await createKnowledgeIngestWebexWindowHandler({
      resolveAccess: jest.fn(async () => null),
      deleteLegacy,
      makeClient: () => clientWith([]),
    })(event(payload));
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('dead-letters a malformed payload', async () => {
    await expect(
      createKnowledgeIngestWebexWindowHandler({ resolveAccess, deleteLegacy })(
        event({ provider: 'webex', roomId: 'room-1', day: 'yesterday', subject: 'x' })
      )
    ).rejects.toThrow('roomId/day/subject');
  });
});
