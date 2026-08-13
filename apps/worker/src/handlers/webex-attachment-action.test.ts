/**
 * The push handler's contract: everything acted on is re-fetched from the
 * WebEx API (never the webhook payload), a push captures even what the
 * classifier ignores, foreign card actions are not this handler's work, and
 * a room mismatch between the action and the message is refused.
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
  getPublicBaseUrl: jest.fn(() => null),
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import { CARD_COMMAND_PUSH } from '@renkei/connector-webex';
import type { WebexMessage, OutgoingMessage, WebexAttachmentAction } from '@renkei/connector-webex';
import { createWebexAttachmentActionHandler } from './webex-attachment-action';
import type { WebexTenantContext } from './webex-context';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

function stubDb(hasExisting = false): { inserted: Array<Record<string, unknown>> } {
  const inserted: Array<Record<string, unknown>> = [];
  const selectChain = {
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () => (hasExisting ? { id: 'item-1' } : undefined),
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

const MESSAGE: WebexMessage = {
  id: 'msg-1',
  roomId: 'room-1',
  roomType: 'group',
  text: 'Can someone pull the Q4 rev cycle reports together?',
  personId: 'person-1',
  personEmail: 'author@example.com',
  parentId: null,
  created: '2026-08-07T12:00:00Z',
};

function action(over: Partial<WebexAttachmentAction> = {}): WebexAttachmentAction {
  return {
    id: 'action-1',
    personId: 'person-2',
    roomId: 'room-1',
    messageId: 'card-msg-1',
    inputs: { command: CARD_COMMAND_PUSH, messageId: 'msg-1', note: 'for the board deck' },
    ...over,
  };
}

interface StubClient {
  client: WebexTenantContext['client'];
  posted: OutgoingMessage[];
}

function stubClient(fetchedAction: WebexAttachmentAction): StubClient {
  const posted: OutgoingMessage[] = [];
  return {
    posted,
    client: {
      getMessage: async () => ok(MESSAGE),
      isRoomMember: async () => ok(true),
      postMessage: async (outgoing: OutgoingMessage) => {
        posted.push(outgoing);
        return ok({ id: 'reply-1' });
      },
      getAttachmentAction: async () => ok(fetchedAction),
      getPerson: async () =>
        ok({ id: 'person-2', emails: ['pusher@example.com'], displayName: 'Pusher' }),
    },
  };
}

function handlerWith(stub: StubClient) {
  return createWebexAttachmentActionHandler({
    resolveContext: async () => ({ client: stub.client, botPersonId: 'bot-1' }),
  });
}

function event(): ClaimedEvent {
  return {
    id: 'evt-2',
    tenant_id: 'tenant-1',
    source: 'webex',
    type: 'attachmentActions.created',
    payload: { id: 'action-1' },
    attempts: 1,
  };
}

beforeEach(() => {
  mockGetDatabase.mockReset();
});

describe('createWebexAttachmentActionHandler', () => {
  it('captures the pushed message even though the classifier is silent', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(action());

    await handlerWith(stub)(event());

    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(String(row.title)).toContain('Pushed from WebEx');
    const evidence = JSON.parse(String(row.evidence));
    expect(evidence.pushedBy).toBe('pusher@example.com');
    expect(evidence.note).toBe('for the board deck');
    expect(String(row.suggested_action)).toContain('jira_create_issue');

    expect(stub.posted).toHaveLength(1);
    expect(stub.posted[0]?.markdown).toContain('Captured in Renkei');
  });

  it('answers "already captured" for a second press without a second item', async () => {
    const { inserted } = stubDb(true);
    const stub = stubClient(action());

    await handlerWith(stub)(event());

    expect(inserted).toHaveLength(0);
    expect(stub.posted[0]?.markdown).toContain('Already captured');
  });

  it('ignores actions from foreign cards silently', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(action({ inputs: { command: 'unrelated', messageId: 'msg-1' } }));

    await handlerWith(stub)(event());

    expect(inserted).toHaveLength(0);
    expect(stub.posted).toHaveLength(0);
  });

  it('refuses a room mismatch between action and message', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(action({ roomId: 'some-other-room' }));

    await handlerWith(stub)(event());

    expect(inserted).toHaveLength(0);
    expect(stub.posted).toHaveLength(0);
  });

  it('throws when the action cannot be fetched, so the retry budget applies', async () => {
    stubDb();
    const stub = stubClient(action());
    stub.client = {
      ...stub.client,
      getAttachmentAction: async () => err('WEBEX_API_ERROR' as const),
    };

    await expect(handlerWith(stub)(event())).rejects.toThrow(
      'could not fetch WebEx attachment action'
    );
  });
});
