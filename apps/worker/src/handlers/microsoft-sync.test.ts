/**
 * One delta round's routing, per resource kind.
 *
 * The inbox row is a trigger feed, not an index: a 'msg' entry publishes
 * the `mail.received` domain event (and only for genuinely new mail) and
 * writes nothing anywhere else, with or without an embedding provider. A
 * lingering `me/events` or To Do row is never polled: calendar and tasks
 * left the index (migrations 135 and 137). Nothing in this handler may
 * touch the embedding queue or the embeddings endpoint — the module does
 * not even import them.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/connector-microsoft', () => ({
  createGraphSubscription: jest.fn(),
  renewGraphSubscription: jest.fn(),
  deleteGraphSubscription: jest.fn(),
  runDeltaRound: jest.fn(),
  initialDeltaUrl: jest.fn(() => 'https://graph.microsoft.com/v1.0/delta'),
}));
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
    scopes: ['Mail.Read'],
    indexing: { mail: true },
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

beforeEach(() => {
  jest.resetAllMocks();
  stubDb();
  mockPublishDomainEvent.mockResolvedValue(undefined);
  mockSubjectForMicrosoftAccount.mockResolvedValue('subject-alice');
  mockIsRecentMail.mockReturnValue(true);
});

describe('runSubscriptionSync — the inbox is a trigger feed, not an index', () => {
  it('publishes mail.received for a new message and writes nothing else', async () => {
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-2' }));

    const result = await runSubscriptionSync(access(), inboxRow());

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockPublishDomainEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
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
        orderingKey: 'microsoft/acct-1',
      })
    );
  });

  it('wakes agents without consulting the knowledge layer at all', async () => {
    // The trigger used to ride the indexing path and died with it when the
    // knowledge layer was off. Mail is not indexed, so the handler no longer
    // imports the embedding provider or the embedding queue: the round
    // publishes and nothing else.
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-2' }));

    await runSubscriptionSync(access(), inboxRow());

    expect(mockPublishDomainEvent).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing on a cursorless (rebuild) round, and never purges', async () => {
    // A fresh series replays the whole mailbox: none of it "arrives".
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-1' }));

    await runSubscriptionSync(access(), { ...inboxRow(), delta_link: null });

    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
  });

  it('publishes nothing for mail outside the recency window', async () => {
    mockIsRecentMail.mockReturnValue(false);
    mockRunDeltaRound.mockResolvedValue(ok({ items: [messageEntry()], deltaLink: 'delta-2' }));

    await runSubscriptionSync(access(), inboxRow());

    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
  });

  it('enqueues no delete for an @removed message — nothing was ever stored', async () => {
    mockRunDeltaRound.mockResolvedValue(
      ok({ items: [{ id: 'msg-9', '@removed': { reason: 'deleted' } }], deltaLink: 'delta-2' })
    );

    const result = await runSubscriptionSync(access(), inboxRow());

    expect(result).toEqual({ changed: 0, removed: 1 });
    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
  });

  it('still persists the cursor so the feed resumes where it stopped', async () => {
    const set = stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-2', nextLink: null }));

    await runSubscriptionSync(access(), inboxRow());

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ delta_link: 'delta-2', sync_status: 'idle' })
    );
  });
});

describe('runSubscriptionSync — a retired calendar row', () => {
  it('never polls me/events and writes nothing', async () => {
    const set = stubDb();

    const result = await runSubscriptionSync(access(), {
      ...inboxRow(),
      resource: 'me/events',
    });

    expect(result).toEqual({ changed: 0, removed: 0 });
    expect(mockRunDeltaRound).not.toHaveBeenCalled();
    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('runSubscriptionSync — a retired To Do row', () => {
  it('never polls a To Do list and writes nothing', async () => {
    const set = stubDb();

    const result = await runSubscriptionSync(access(), {
      ...inboxRow(),
      id: 'sub-row-2',
      resource: 'me/todo/lists/list-1/tasks',
    });

    expect(result).toEqual({ changed: 0, removed: 0 });
    expect(mockRunDeltaRound).not.toHaveBeenCalled();
    expect(mockPublishDomainEvent).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
