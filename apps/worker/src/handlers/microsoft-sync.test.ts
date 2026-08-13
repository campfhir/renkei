/**
 * One delta round's routing into the embedding queue: a cursorless round
 * leads with a purge.prefix event, 'msg' entries become ingest.email events
 * (the sanitizer runs in the embedding worker, not here — see
 * knowledge-ingest.test.ts for that wiring), other kinds become
 * ingest.object, and @removed entries become delete.object. Nothing in this
 * handler may touch the embeddings endpoint.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/connector-microsoft', () => ({
  createGraphSubscription: jest.fn(),
  renewGraphSubscription: jest.fn(),
  runDeltaRound: jest.fn(),
  initialDeltaUrl: jest.fn(() => 'https://graph.microsoft.com/v1.0/delta'),
  microsoftRefId: (upn: string, kind: string, id: string) => `${upn}/${kind}/${id}`,
  graphRequest: jest.fn(),
}));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
}));
jest.mock('../enqueue', () => ({ enqueueKnowledgeEvent: jest.fn() }));

import { ok } from '@campfhir/safe-functions/helpers';
import { runSubscriptionSync } from './microsoft-sync';
import type { MicrosoftAccess } from './microsoft-access';
import type { SubscriptionRow } from './microsoft-sync';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { runDeltaRound: mockRunDeltaRound } = jest.requireMock<{ runDeltaRound: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const { resolveEmbeddingProvider: mockResolveEmbeddingProvider } = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
}>('@renkei/knowledge');
const { enqueueKnowledgeEvent: mockEnqueueKnowledgeEvent } = jest.requireMock<{
  enqueueKnowledgeEvent: jest.Mock;
}>('../enqueue');

function stubDb(): jest.Mock {
  // Returns the `set` spy so cursor-persistence tests can assert what the
  // round actually wrote back to webhook_subscriptions.
  const set = jest.fn(() => ({ where: () => ({ execute: async () => [] }) }));
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: { updateTable: () => ({ set }) },
  });
  return set;
}

function access(): MicrosoftAccess {
  return {
    accountId: 'acct-1',
    accessToken: 'token',
    upn: 'alice@example.com',
    scopes: ['Mail.Read'],
  };
}

function row(): SubscriptionRow {
  return {
    id: 'sub-row-1',
    resource: "me/mailFolders('inbox')/messages",
    subscription_id: 'graph-sub-1',
    client_state: 'state',
    expires_at: new Date(),
    delta_link: null,
  };
}

function messageEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    subject: 'Hello',
    from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
    receivedDateTime: '2026-08-10T12:00:00Z',
    body: { contentType: 'text', content: 'Just checking in.' },
    ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  stubDb();
  mockResolveEmbeddingProvider.mockResolvedValue({ embed: jest.fn() });
  mockEnqueueKnowledgeEvent.mockResolvedValue(undefined);
});

describe('runSubscriptionSync — rebuild purge', () => {
  /**
   * A cursorless round returns the whole current state, so it is the one
   * safe moment to drop the previous chunks — otherwise re-index can only
   * ever ADD, and items deleted upstream (or newly excluded by changed
   * rules) outlive their source. The purge rides the embedding queue ahead
   * of the per-item jobs; the shared ordering key keeps it first.
   */
  it('enqueues a namespace purge before the per-item events, on a cursorless round', async () => {
    stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-1' }));

    await runSubscriptionSync('tenant-1', access(), { ...row(), delta_link: null });

    const calls = mockEnqueueKnowledgeEvent.mock.calls;
    expect(calls[0]).toEqual([
      'tenant-1',
      'purge.prefix',
      { provider: 'microsoft', refIdPrefix: 'alice@example.com/msg/' },
      'microsoft/alice@example.com/msg',
    ]);
    expect(calls[1]?.[1]).toBe('ingest.email');
    // Purge and re-ingests share the mailbox-kind key: the ordering that
    // used to require a single consumer now survives horizontal scale.
    expect(calls[1]?.[3]).toBe('microsoft/alice@example.com/msg');
  });

  it('enqueues no purge on an incremental round', async () => {
    stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-2' }));

    await runSubscriptionSync('tenant-1', access(), { ...row(), delta_link: 'delta-1' });

    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });
});

describe('runSubscriptionSync — cursor persistence', () => {
  it('persists the deltaLink and returns to idle when Graph closes the round', async () => {
    const set = stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-2', nextLink: null }));

    await runSubscriptionSync('tenant-1', access(), { ...row(), delta_link: 'delta-1' });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ delta_link: 'delta-2', sync_status: 'idle' })
    );
  });

  /**
   * The forever-rebuild bug: a page-capped round used to persist NULL,
   * which reopened the series next round — purge, same first pages,
   * NULL again — so a mailbox larger than one round never finished
   * indexing. The capped round's nextLink is as resumable as a deltaLink;
   * storing it makes the next round continue where this one stopped.
   */
  it('persists a capped round’s nextLink so the next round resumes, without a purge', async () => {
    const set = stubDb();
    mockRunDeltaRound.mockResolvedValue(
      ok({ items: [messageEntry()], deltaLink: null, nextLink: 'https://graph/page-11' })
    );

    await runSubscriptionSync('tenant-1', access(), {
      ...row(),
      delta_link: 'https://graph/page-1',
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ delta_link: 'https://graph/page-11', sync_status: 'syncing' })
    );
    // A capped continuation is mid-series, not a fresh one: no purge.
    const purges = mockEnqueueKnowledgeEvent.mock.calls.filter(
      (call) => call[1] === 'purge.prefix'
    );
    expect(purges).toHaveLength(0);
  });

  it('clears the cursor only when Graph produced neither link', async () => {
    const set = stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: null, nextLink: null }));

    await runSubscriptionSync('tenant-1', access(), { ...row(), delta_link: 'delta-1' });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ delta_link: null }));
  });
});

describe('runSubscriptionSync — routing into the embedding queue', () => {
  it('turns a mail entry into one ingest.email event carrying the raw message', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: { items: [messageEntry()], deltaLink: 'next' },
    });

    const result = await runSubscriptionSync('tenant-1', access(), {
      ...row(),
      delta_link: 'delta-1',
    });

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledTimes(1);
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'ingest.email',
      expect.objectContaining({
        provider: 'microsoft',
        refId: 'alice@example.com/msg/msg-1',
        ownerUpn: 'alice@example.com',
        accountId: 'acct-1',
        raw: expect.objectContaining({ subject: 'Hello', fromAddress: 'bob@example.com' }),
        metadata: expect.objectContaining({ kind: 'msg', subject: 'Hello' }),
        sourceAt: '2026-08-10T12:00:00Z',
      }),
      'microsoft/alice@example.com/msg'
    );
  });

  it('turns an @removed entry into a delete.object event', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: { items: [{ id: 'msg-9', '@removed': { reason: 'deleted' } }], deltaLink: 'next' },
    });

    const result = await runSubscriptionSync('tenant-1', access(), {
      ...row(),
      delta_link: 'delta-1',
    });

    expect(result).toEqual({ changed: 0, removed: 1 });
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'delete.object',
      { provider: 'microsoft', refId: 'alice@example.com/msg/msg-9' },
      'microsoft/alice@example.com/msg'
    );
  });

  it('leaves event/task kinds on the contentOf path, as ingest.object events', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: {
        items: [
          {
            id: 'evt-1',
            subject: 'Standup',
            start: { dateTime: '2026-08-10T09:00:00Z' },
            end: { dateTime: '2026-08-10T09:15:00Z' },
            organizer: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
            body: { content: 'Daily sync' },
          },
        ],
        deltaLink: 'next',
      },
    });

    const result = await runSubscriptionSync('tenant-1', access(), {
      ...row(),
      resource: 'me/events',
      delta_link: 'delta-1',
    });

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'ingest.object',
      expect.objectContaining({
        provider: 'microsoft',
        content: expect.stringContaining('Event: Standup'),
      }),
      'microsoft/alice@example.com/evt'
    );
  });

  it('enqueues nothing for items when the org has no embedding provider', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: { items: [messageEntry()], deltaLink: 'next' },
    });

    const result = await runSubscriptionSync('tenant-1', access(), {
      ...row(),
      delta_link: 'delta-1',
    });

    expect(result).toEqual({ changed: 0, removed: 0 });
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });
});
