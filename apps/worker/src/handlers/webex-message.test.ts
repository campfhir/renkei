/**
 * The webex handler's contract: fetch, filter, classify, suggest — never
 * execute. The bot's own messages are skipped, chatter produces nothing,
 * an issue report produces exactly one suggested actionable item, and an
 * unfetchable message throws so the queue's retry budget applies.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(async () => null),
  ingestChunk: jest.fn(async () => ({ ok: true, val: undefined })),
  searchKnowledge: jest.fn(async () => ({ ok: true, val: { hits: [], elided: 0 } })),
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexMessage } from '@renkei/connector-webex';
import { createWebexMessageHandler } from './webex-message';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

function stubDb(): { inserted: Array<Record<string, unknown>> } {
  const inserted: Array<Record<string, unknown>> = [];
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
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
    created: '2026-08-07T12:00:00Z',
    ...over,
  };
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
  it('records one suggested item for an issue report', async () => {
    const { inserted } = stubDb();
    const handler = createWebexMessageHandler({
      resolveContext: async () => ({
        client: { getMessage: async () => ok(message({ text: 'The build server is down' })), isRoomMember: async () => ok(true) },
        botPersonId: 'bot-1',
      }),
    });

    await handler(event());

    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row.tenant_id).toBe('tenant-1');
    expect(row.status).toBeUndefined(); // default 'suggested' comes from the schema
    expect(String(row.title)).toContain('The build server is down');
    expect(String(row.suggested_action)).toContain('create_issue');
  });

  it('skips the bot’s own messages', async () => {
    const { inserted } = stubDb();
    const handler = createWebexMessageHandler({
      resolveContext: async () => ({
        client: { getMessage: async () => ok(message({ personId: 'bot-1', text: 'it is down' })), isRoomMember: async () => ok(true) },
        botPersonId: 'bot-1',
      }),
    });

    await handler(event());

    expect(inserted).toHaveLength(0);
  });

  it('produces nothing for chatter', async () => {
    const { inserted } = stubDb();
    const handler = createWebexMessageHandler({
      resolveContext: async () => ({
        client: { getMessage: async () => ok(message({ text: 'lunch at noon?' })), isRoomMember: async () => ok(true) },
        botPersonId: 'bot-1',
      }),
    });

    await handler(event());

    expect(inserted).toHaveLength(0);
  });

  it('throws when the message cannot be fetched, so the retry budget applies', async () => {
    stubDb();
    const handler = createWebexMessageHandler({
      resolveContext: async () => ({
        client: { getMessage: async () => err('WEBEX_API_ERROR' as const), isRoomMember: async () => ok(true) },
        botPersonId: 'bot-1',
      }),
    });

    await expect(handler(event())).rejects.toThrow('could not fetch WebEx message');
  });

  it('throws on a payload with no message id', async () => {
    stubDb();
    const handler = createWebexMessageHandler({
      resolveContext: async () => ({
        client: { getMessage: async () => ok(message({})), isRoomMember: async () => ok(true) },
        botPersonId: null,
      }),
    });

    await expect(handler({ ...event(), payload: { roomId: 'room-1' } })).rejects.toThrow(
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

  it('indexes the message and attaches gate-cleared related priors when embeddings are configured', async () => {
    const knowledge = jest.requireMock<{
      resolveEmbeddingProvider: jest.Mock;
      ingestChunk: jest.Mock;
      searchKnowledge: jest.Mock;
    }>('@renkei/knowledge');
    const embedder = { embed: jest.fn() };
    knowledge.resolveEmbeddingProvider.mockResolvedValueOnce(embedder);
    knowledge.searchKnowledge.mockResolvedValueOnce({
      ok: true,
      val: {
        hits: [
          { provider: 'webex', refId: 'room-1/m0', content: 'build server crashed yesterday', metadata: {}, distance: 0.1 },
        ],
        elided: 1,
      },
    });

    const { inserted } = stubDb();
    const handler = createWebexMessageHandler({
      resolveContext: async () => ({
        client: { getMessage: async () => ok(message({ text: 'The build server is down' })), isRoomMember: async () => ok(true) },
        botPersonId: 'bot-1',
      }),
    });

    await handler(event());

    expect(knowledge.ingestChunk).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    const evidence = JSON.parse(String(inserted[0]!.evidence));
    expect(evidence.related).toHaveLength(1);
    expect(evidence.related[0].refId).toBe('room-1/m0');
    expect(evidence.relatedElided).toBe(1);
  });
});
