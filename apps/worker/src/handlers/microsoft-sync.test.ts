/**
 * One delta round's routing, per resource kind.
 *
 * The inbox row is a trigger feed, not an index: a 'msg' entry publishes
 * the `mail.received` domain event (and only for genuinely new mail) and
 * enqueues NOTHING on the embedding queue — no ingest, no purge, no
 * delete — with or without an embedding provider. To Do rows are indexed:
 * a cursorless round leads with a purge.prefix event, entries become
 * ingest.object, @removed entries become delete.object. A lingering
 * `me/events` row is never polled. Nothing in this handler may touch the
 * embeddings endpoint.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/connector-microsoft', () => ({
  createGraphSubscription: jest.fn(),
  renewGraphSubscription: jest.fn(),
  deleteGraphSubscription: jest.fn(),
  runDeltaRound: jest.fn(),
  initialDeltaUrl: jest.fn(() => 'https://graph.microsoft.com/v1.0/delta'),
  microsoftRefId: (upn: string, kind: string, id: string) => `${upn}/${kind}/${id}`,
  graphRequest: jest.fn(),
}));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
}));
jest.mock('@renkei/email-sanitizer', () => ({
  applyCleanerScriptsToItem: async (inputs: { content: string }) => inputs.content,
  decodeBody: (value: string) => value,
  normalizeBody: (body: { content: string }) => body.content,
}));
jest.mock('../enqueue', () => ({ enqueueKnowledgeEvent: jest.fn() }));
jest.mock('../domain-events', () => ({
  publishDomainEvent: jest.fn(),
  subjectForMicrosoftAccount: jest.fn(),
  isRecentMail: jest.fn(() => true),
  BODY_PREVIEW_CHARS: 1024,
}));

import { ok } from '@campfhir/safe-functions/helpers';
import { runSubscriptionSync } from './microsoft-sync';
import { authedFetch } from '@renkei/delegate-client';
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
const {
  publishDomainEvent: mockPublishDomainEvent,
  subjectForMicrosoftAccount: mockSubjectForMicrosoftAccount,
  isRecentMail: mockIsRecentMail,
} = jest.requireMock<{
  publishDomainEvent: jest.Mock;
  subjectForMicrosoftAccount: jest.Mock;
  isRecentMail: jest.Mock;
}>('../domain-events');

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
    auth: authedFetch(async () => new Response(), 'microsoft:tenant-1:acct-1'),
    upn: 'alice@example.com',
    scopes: ['Mail.Read', 'Tasks.Read'],
    indexing: { mail: true, tasks: true },
  };
}

function inboxRow(): SubscriptionRow {
  return {
    id: 'sub-row-1',
    resource: "me/mailFolders('inbox')/messages",
    subscription_id: 'graph-sub-1',
    client_state: 'state',
    expires_at: new Date(),
    delta_link: 'delta-1',
  };
}

function tasksRow(): SubscriptionRow {
  return {
    ...inboxRow(),
    id: 'sub-row-2',
    resource: 'me/todo/lists/list-1/tasks',
  };
}

function messageEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    subject: 'Hello',
    from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
    receivedDateTime: '2026-08-10T12:00:00Z',
    bodyPreview: 'Just checking in.',
    body: { contentType: 'text', content: 'Just checking in.' },
    ...over,
  };
}

function taskEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    title: 'Renew the contract',
    status: 'notStarted',
    lastModifiedDateTime: '2026-08-10T09:00:00Z',
    body: { contentType: 'text', content: 'Call procurement first.' },
    ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  stubDb();
  mockResolveEmbeddingProvider.mockResolvedValue({ embed: jest.fn() });
  mockEnqueueKnowledgeEvent.mockResolvedValue(undefined);
  mockPublishDomainEvent.mockResolvedValue(undefined);
  mockSubjectForMicrosoftAccount.mockResolvedValue('subject-alice');
  mockIsRecentMail.mockReturnValue(true);
});

describe('runSubscriptionSync — the inbox is a trigger feed, not an index', () => {
  it('publishes mail.received for a new message and enqueues no index write', async () => {
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-2' }));

    const result = await runSubscriptionSync('tenant-1', access(), inboxRow());

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
    expect(mockPublishDomainEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        provider: 'microsoft',
        type: 'mail.received',
        ownerSubject: 'subject-alice',
        data: {
          subject: 'Hello',
          body: 'Just checking in.',
          from: 'bob@example.com',
          messageId: 'msg-1',
        },
        occurredAt: '2026-08-10T12:00:00Z',
        orderingKey: 'microsoft/tenant-1/acct-1',
      })
    );
  });

  it('wakes agents even when the org has no embedding provider', async () => {
    // The trigger used to ride the indexing path and died with it when the
    // knowledge layer was off. Mail is not indexed, so the embedder is not
    // consulted here at all.
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-2' }));

    await runSubscriptionSync('tenant-1', access(), inboxRow());

    expect(mockPublishDomainEvent).toHaveBeenCalledTimes(1);
    expect(mockResolveEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });

  it('publishes nothing on a cursorless (rebuild) round, and never purges', async () => {
    // A fresh series replays the whole mailbox: none of it "arrives".
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-1' }));

    await runSubscriptionSync('tenant-1', access(), { ...inboxRow(), delta_link: null });

    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });

  it('publishes nothing for mail outside the recency window', async () => {
    mockIsRecentMail.mockReturnValue(false);
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-2' }));

    await runSubscriptionSync('tenant-1', access(), inboxRow());

    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
  });

  it('enqueues no delete for an @removed message — nothing was ever stored', async () => {
    mockRunDeltaRound.mockResolvedValue(
      ok({ items: [{ id: 'msg-9', '@removed': { reason: 'deleted' } }], deltaLink: 'delta-2' })
    );

    const result = await runSubscriptionSync('tenant-1', access(), inboxRow());

    expect(result).toEqual({ changed: 0, removed: 1 });
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
  });

  it('still persists the cursor so the feed resumes where it stopped', async () => {
    const set = stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-2', nextLink: null }));

    await runSubscriptionSync('tenant-1', access(), inboxRow());

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ delta_link: 'delta-2', sync_status: 'idle' })
    );
  });
});

describe('runSubscriptionSync — a retired calendar row', () => {
  it('never polls me/events and writes nothing', async () => {
    const set = stubDb();

    const result = await runSubscriptionSync('tenant-1', access(), {
      ...inboxRow(),
      resource: 'me/events',
    });

    expect(result).toEqual({ changed: 0, removed: 0 });
    expect(mockRunDeltaRound).not.toHaveBeenCalled();
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('runSubscriptionSync — To Do rebuild purge', () => {
  /**
   * A cursorless round returns the whole current state, so it is the one
   * safe moment to drop the previous chunks — otherwise re-index can only
   * ever ADD, and items deleted upstream (or newly excluded by changed
   * rules) outlive their source. The purge rides the embedding queue ahead
   * of the per-item jobs; the shared ordering key keeps it first.
   */
  it('enqueues a namespace purge before the per-item events, on a cursorless round', async () => {
    mockRunDeltaRound.mockResolvedValue(ok({ items: [taskEntry()], deltaLink: 'delta-1' }));

    await runSubscriptionSync('tenant-1', access(), { ...tasksRow(), delta_link: null });

    const calls = mockEnqueueKnowledgeEvent.mock.calls;
    expect(calls[0]).toEqual([
      'tenant-1',
      'purge.prefix',
      { provider: 'microsoft', refIdPrefix: 'alice@example.com/task/' },
      'microsoft/alice@example.com/task',
    ]);
    expect(calls[1]?.[1]).toBe('ingest.object');
    // Purge and re-ingests share the list-kind key: the ordering that used
    // to require a single consumer now survives horizontal scale.
    expect(calls[1]?.[3]).toBe('microsoft/alice@example.com/task');
  });

  it('enqueues no purge on an incremental round', async () => {
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-2' }));

    await runSubscriptionSync('tenant-1', access(), tasksRow());

    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });
});

describe('runSubscriptionSync — To Do cursor persistence', () => {
  it('persists the deltaLink and returns to idle when Graph closes the round', async () => {
    const set = stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-2', nextLink: null }));

    await runSubscriptionSync('tenant-1', access(), tasksRow());

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ delta_link: 'delta-2', sync_status: 'idle' })
    );
  });

  /**
   * The forever-rebuild bug: a page-capped round used to persist NULL,
   * which reopened the series next round — purge, same first pages,
   * NULL again — so a list larger than one round never finished indexing.
   * The capped round's nextLink is as resumable as a deltaLink; storing it
   * makes the next round continue where this one stopped.
   */
  it('persists a capped round’s nextLink so the next round resumes, without a purge', async () => {
    const set = stubDb();
    mockRunDeltaRound.mockResolvedValue(
      ok({ items: [taskEntry()], deltaLink: null, nextLink: 'https://graph/page-11' })
    );

    await runSubscriptionSync('tenant-1', access(), {
      ...tasksRow(),
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

    await runSubscriptionSync('tenant-1', access(), tasksRow());

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ delta_link: null }));
  });
});

describe('runSubscriptionSync — To Do routing into the embedding queue', () => {
  it('turns a task into one ingest.object event', async () => {
    mockRunDeltaRound.mockResolvedValue(ok({ items: [taskEntry()], deltaLink: 'next' }));

    const result = await runSubscriptionSync('tenant-1', access(), tasksRow());

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledTimes(1);
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'ingest.object',
      expect.objectContaining({
        provider: 'microsoft',
        refId: 'alice@example.com/task/task-1',
        content: expect.stringContaining('Task: Renew the contract'),
        metadata: expect.objectContaining({ kind: 'task', subject: 'Renew the contract' }),
        sourceAt: '2026-08-10T09:00:00Z',
      }),
      'microsoft/alice@example.com/task'
    );
    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
  });

  it('turns an @removed task into a delete.object event', async () => {
    mockRunDeltaRound.mockResolvedValue(
      ok({ items: [{ id: 'task-9', '@removed': { reason: 'deleted' } }], deltaLink: 'next' })
    );

    const result = await runSubscriptionSync('tenant-1', access(), tasksRow());

    expect(result).toEqual({ changed: 0, removed: 1 });
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'delete.object',
      { provider: 'microsoft', refId: 'alice@example.com/task/task-9' },
      'microsoft/alice@example.com/task'
    );
  });

  it('removes a task that has neither title nor body instead of embedding a shell', async () => {
    mockRunDeltaRound.mockResolvedValue(
      ok({ items: [taskEntry({ title: '', body: { content: '' } })], deltaLink: 'next' })
    );

    await runSubscriptionSync('tenant-1', access(), tasksRow());

    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'delete.object',
      { provider: 'microsoft', refId: 'alice@example.com/task/task-1' },
      'microsoft/alice@example.com/task'
    );
  });

  it('enqueues nothing for tasks when the org has no embedding provider', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    mockRunDeltaRound.mockResolvedValue(ok({ items: [taskEntry()], deltaLink: 'next' }));

    const result = await runSubscriptionSync('tenant-1', access(), tasksRow());

    expect(result).toEqual({ changed: 0, removed: 0 });
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });
});
