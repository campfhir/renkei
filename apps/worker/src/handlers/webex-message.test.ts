/**
 * The ambient handler's contract: fetch, filter, capture, reply — never
 * execute. The bot's own messages are skipped silently; an issue report
 * becomes one suggested item plus a threaded confirmation; chatter becomes
 * no item but a "Push to Renkei" card, so the human can capture what the
 * classifier missed without leaving WebEx.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
// kysely is ESM and cannot be required here; the only use on this path is the
// sql tag building the dedupe fragment, which the stubbed chain ignores.
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(async () => null),
  ingestChunk: jest.fn(async () => ({ ok: true, val: undefined })),
  searchKnowledge: jest.fn(async () => ({ ok: true, val: { hits: [], elided: 0 } })),
}));
jest.mock('@renkei/settings', () => ({
  getPublicBaseUrl: jest.fn(async () => ({ ok: true, val: 'https://renkei.example.com' })),
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexMessage, OutgoingMessage } from '@renkei/connector-webex';
import { createWebexMessageHandler } from './webex-message';
import type { WebexTenantContext } from './webex-context';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

function stubDb(): { inserted: Array<Record<string, unknown>> } {
  const inserted: Array<Record<string, unknown>> = [];
  const selectChain = {
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () => undefined,
  };
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: () => selectChain,
      insertInto: () => ({
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            inserted.push(row);
            return [];
          },
        }),
      }),
    },
  });
  return { inserted };
}

function message(over: Partial<WebexMessage>): WebexMessage {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    roomType: 'group',
    text: 'hello',
    personId: 'person-1',
    personEmail: 'sam@example.com',
    parentId: null,
    created: '2026-08-07T12:00:00Z',
    ...over,
  };
}

interface StubClient {
  client: WebexTenantContext['client'];
  posted: OutgoingMessage[];
}

function stubClient(fetched: WebexMessage): StubClient {
  const posted: OutgoingMessage[] = [];
  return {
    posted,
    client: {
      getMessage: async () => ok(fetched),
      isRoomMember: async () => ok(true),
      postMessage: async (outgoing: OutgoingMessage) => {
        posted.push(outgoing);
        return ok({ id: 'reply-1' });
      },
      getAttachmentAction: async () => err('WEBEX_API_ERROR' as const),
      getPerson: async () => err('WEBEX_API_ERROR' as const),
    },
  };
}

function handlerWith(stub: StubClient, botPersonId: string | null = 'bot-1') {
  return createWebexMessageHandler({
    resolveContext: async () => ({ client: stub.client, botPersonId }),
  });
}

function event(): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'webex',
    type: 'messages.created',
    payload: { id: 'msg-1', roomId: 'room-1' },
    attempts: 1,
  };
}

beforeEach(() => {
  mockGetDatabase.mockReset();
});

describe('createWebexMessageHandler', () => {
  it('captures an issue report and confirms in-thread', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(message({ text: 'The build server is down' }));

    await handlerWith(stub)(event());

    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row.tenant_id).toBe('tenant-1');
    expect(String(row.title)).toContain('The build server is down');
    expect(String(row.suggested_action)).toContain('create_issue');

    expect(stub.posted).toHaveLength(1);
    expect(stub.posted[0]?.parentId).toBe('msg-1');
    expect(stub.posted[0]?.markdown).toContain('card feed');
    expect(stub.posted[0]?.markdown).toContain('https://renkei.example.com/tenant/tenant-1/cards');
  });

  it('offers the Push to Renkei card for chatter instead of capturing', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(message({ text: 'lunch at noon?' }));

    await handlerWith(stub)(event());

    expect(inserted).toHaveLength(0);
    expect(stub.posted).toHaveLength(1);
    const attachments = stub.posted[0]?.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(JSON.stringify(attachments[0])).toContain('push_to_renkei');
    expect(JSON.stringify(attachments[0])).toContain('msg-1');
  });

  it('skips the bot’s own messages silently — no item, no reply', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(message({ personId: 'bot-1', text: 'it is down' }));

    await handlerWith(stub)(event());

    expect(inserted).toHaveLength(0);
    expect(stub.posted).toHaveLength(0);
  });

  it('threads the reply under the message’s existing thread root', async () => {
    stubDb();
    const stub = stubClient(message({ text: 'lunch at noon?', parentId: 'thread-root-1' }));

    await handlerWith(stub)(event());

    expect(stub.posted[0]?.parentId).toBe('thread-root-1');
  });

  it('throws when the message cannot be fetched, so the retry budget applies', async () => {
    stubDb();
    const stub = stubClient(message({}));
    stub.client = { ...stub.client, getMessage: async () => err('WEBEX_API_ERROR' as const) };

    await expect(handlerWith(stub)(event())).rejects.toThrow('could not fetch WebEx message');
  });

  it('throws on a payload with no message id', async () => {
    stubDb();
    const stub = stubClient(message({}));

    await expect(handlerWith(stub, null)({ ...event(), payload: { roomId: 'room-1' } })).rejects.toThrow(
      'no message id'
    );
  });

  it('propagates an unconfigured-connector error into the retry path', async () => {
    stubDb();
    const handler = createWebexMessageHandler({
      resolveContext: async () => {
        throw new Error('webex connector is not configured or disabled for tenant tenant-1');
      },
    });

    await expect(handler(event())).rejects.toThrow('not configured');
  });
});
