/**
 * The ambient handler's contract: fetch, filter, check identity, capture,
 * reply — never execute. The bot's own messages are skipped silently; a
 * sender with no linked Renkei account gets a registration nudge instead of
 * a capture; an issue report becomes one suggested item plus a threaded
 * confirmation; chatter becomes no item but a "Push to Renkei" card, so the
 * human can capture what the classifier missed without leaving WebEx. When
 * the sender's own WebEx grant turns up a forwarded original elsewhere, that
 * context rides along on the reply.
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
  getPublicBaseUrl: jest.fn(() => 'https://renkei.example.com'),
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexMessage, OutgoingMessage } from '@renkei/connector-webex';
import { createWebexMessageHandler } from './webex-message';
import type { WebexTenantContext } from './webex-context';
import type { ForwardedOrigin } from './webex-forward-context';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

function stubDb(): { inserted: Array<Record<string, unknown>> } {
  const inserted: Array<Record<string, unknown>> = [];
  const selectChain = {
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () => undefined,
  };
  // The feed link resolves the tenant's slug (pages are keyed by slug).
  const tenantChain = {
    select: () => tenantChain,
    where: () => tenantChain,
    executeTakeFirst: async () => ({ slug: 'tenant-one' }),
  };
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: (table: string) => (table === 'tenants' ? tenantChain : selectChain),
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

interface HandlerOverrides {
  botPersonId?: string | null;
  hasLinkedIdentity?: boolean;
  webexUserAccessToken?: string | null;
  forwardedOrigin?: ForwardedOrigin | null;
}

function handlerWith(stub: StubClient, overrides: HandlerOverrides = {}) {
  const {
    botPersonId = 'bot-1',
    hasLinkedIdentity = true,
    webexUserAccessToken = null,
    forwardedOrigin = null,
  } = overrides;
  return createWebexMessageHandler({
    resolveContext: async () => ({ client: stub.client, botPersonId }),
    hasLinkedIdentity: async () => hasLinkedIdentity,
    resolveLinkedWebexUserAccess: async () =>
      webexUserAccessToken ? { accessToken: webexUserAccessToken } : null,
    findForwardedOrigin: async () => forwardedOrigin,
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
    expect(String(row.suggested_action)).toContain('jira_create_issue');

    expect(stub.posted).toHaveLength(1);
    expect(stub.posted[0]?.parentId).toBe('msg-1');
    expect(stub.posted[0]?.markdown).toContain('card feed');
    // The tenant root IS the feed; /home only survives as a redirect.
    expect(stub.posted[0]?.markdown).toContain('https://renkei.example.com/tenant-one)');
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

  it('nudges an unlinked sender to register instead of capturing', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(message({ text: 'The build server is down' }));

    await handlerWith(stub, { hasLinkedIdentity: false })(event());

    expect(inserted).toHaveLength(0);
    expect(stub.posted).toHaveLength(1);
    expect(stub.posted[0]?.parentId).toBe('msg-1');
    // The registration nudge points at the tenant root, with no path after
    // it — visiting that signed out is what creates the identities row.
    expect(stub.posted[0]?.markdown).toContain('https://renkei.example.com/tenant-one');
    expect(stub.posted[0]?.markdown).not.toMatch(/tenant-one\/\w/);
  });

  it('words the registration nudge without a link when there is no public base URL', async () => {
    const { getPublicBaseUrl } = jest.requireMock<{ getPublicBaseUrl: jest.Mock }>(
      '@renkei/settings'
    );
    getPublicBaseUrl.mockReturnValueOnce(null);
    stubDb();
    const stub = stubClient(message({}));

    await handlerWith(stub, { hasLinkedIdentity: false })(event());

    expect(stub.posted[0]?.markdown).toContain('ask your admin');
  });

  it('does not gate a message with no personEmail on identity — falls through to capture', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(message({ text: 'The build server is down', personEmail: null }));

    // hasLinkedIdentity would fail the test if called for a null email — it
    // is not overridden here, so a call means the guard is missing.
    await createWebexMessageHandler({
      resolveContext: async () => ({ client: stub.client, botPersonId: 'bot-1' }),
      hasLinkedIdentity: async () => {
        throw new Error('should not be called without a personEmail');
      },
    })(event());

    expect(inserted).toHaveLength(1);
  });

  it('appends the forwarded-origin note when the sender’s own WebEx turns one up', async () => {
    const { inserted } = stubDb();
    const stub = stubClient(message({ text: 'The build server is down' }));
    const origin: ForwardedOrigin = {
      roomId: 'room-elsewhere',
      roomTitle: 'Ops War Room',
      messageId: 'orig-msg-1',
      personEmail: 'reporter@example.com',
      created: '2026-08-07T11:55:00Z',
    };

    await handlerWith(stub, { webexUserAccessToken: 'user-token', forwardedOrigin: origin })(
      event()
    );

    expect(inserted).toHaveLength(1);
    const evidence = JSON.parse(String(inserted[0]!.evidence));
    expect(evidence.forwardedOrigin).toEqual(origin);
    expect(stub.posted[0]?.markdown).toContain('Ops War Room');
    expect(stub.posted[0]?.markdown).toContain('reporter@example.com');
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

    await expect(
      handlerWith(stub, { botPersonId: null })({ ...event(), payload: { roomId: 'room-1' } })
    ).rejects.toThrow('no message id');
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
