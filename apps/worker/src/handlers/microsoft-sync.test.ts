/**
 * The mail branch of one delta round: every 'msg' entry goes through
 * sanitizeEmailForTenant before it can reach the embedder. This suite mocks
 * that call directly — its own routing/drift behavior is covered by
 * packages/email-sanitizer's fixture suite — and asserts the wiring: an
 * 'index' result reaches ingestObjectChunks with its cleaned content, an
 * 'excluded' result never does and clears any stale chunk instead.
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
  ingestObjectChunks: jest.fn(),
  deleteObjectChunks: jest.fn(),
}));
jest.mock('@renkei/email-sanitizer', () => ({
  sanitizeEmailForTenant: jest.fn(),
}));

import { ok } from '@campfhir/safe-functions/helpers';
import { runSubscriptionSync } from './microsoft-sync';
import type { MicrosoftAccess } from './microsoft-access';
import type { SubscriptionRow } from './microsoft-sync';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { runDeltaRound: mockRunDeltaRound } = jest.requireMock<{ runDeltaRound: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const {
  resolveEmbeddingProvider: mockResolveEmbeddingProvider,
  ingestObjectChunks: mockIngestObjectChunks,
  deleteObjectChunks: mockDeleteObjectChunks,
} = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
  ingestObjectChunks: jest.Mock;
  deleteObjectChunks: jest.Mock;
}>('@renkei/knowledge');
const { sanitizeEmailForTenant: mockSanitizeEmailForTenant } = jest.requireMock<{
  sanitizeEmailForTenant: jest.Mock;
}>('@renkei/email-sanitizer');

function stubDb(): void {
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      updateTable: () => ({
        set: () => ({ where: () => ({ execute: async () => [] }) }),
      }),
    },
  });
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
  mockIngestObjectChunks.mockResolvedValue(ok({ chunks: 1 }));
  mockDeleteObjectChunks.mockResolvedValue(ok());
});

describe('runSubscriptionSync — rebuild purge', () => {
  /**
   * A cursorless round returns the whole current state, so it is the one
   * safe moment to drop the previous chunks — otherwise re-index can only
   * ever ADD, and items deleted upstream (or newly excluded by changed
   * rules) outlive their source.
   */
  it('purges the resource namespace before re-ingesting, on a cursorless round', async () => {
    stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-1' }));
    mockResolveEmbeddingProvider.mockResolvedValue({ embed: async () => [[0.1]] });

    await runSubscriptionSync('tenant-1', access(), { ...row(), delta_link: null });

    expect(mockDeleteObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      'microsoft',
      'alice@example.com/msg/',
      { prefixOnly: true }
    );
  });

  it('leaves the index alone on an incremental round', async () => {
    stubDb();
    mockRunDeltaRound.mockResolvedValue(ok({ items: [], deltaLink: 'delta-2' }));
    mockResolveEmbeddingProvider.mockResolvedValue({ embed: async () => [[0.1]] });

    await runSubscriptionSync('tenant-1', access(), { ...row(), delta_link: 'delta-1' });

    expect(mockDeleteObjectChunks).not.toHaveBeenCalled();
  });
});

describe('runSubscriptionSync — mail branch', () => {
  it('indexes the sanitized content for a human message', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: { items: [messageEntry()], deltaLink: 'next' },
    });
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'index',
      content: 'Subject: Hello\n\nJust checking in.',
      category: 'human',
      matchedRuleId: null,
      senderKey: null,
      templateId: null,
      templateVersion: null,
      matchScore: null,
      needsReview: false,
    });

    const result = await runSubscriptionSync('tenant-1', access(), row());

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockSanitizeEmailForTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        provider: 'microsoft',
        refId: 'alice@example.com/msg/msg-1',
        ownerUpn: 'alice@example.com',
        raw: expect.objectContaining({ subject: 'Hello', fromAddress: 'bob@example.com' }),
        embedder: expect.objectContaining({ embed: expect.any(Function) }),
      })
    );
    expect(mockIngestObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({ content: 'Subject: Hello\n\nJust checking in.' })
    );
    // The only delete in a cursorless round is the pre-rebuild purge; this
    // message must not also be cleared individually.
    expect(mockDeleteObjectChunks).not.toHaveBeenCalledWith(
      'tenant-1',
      'microsoft',
      'alice@example.com/msg/1'
    );
  });

  it('excludes marketing mail — never embedded, any stale chunk cleared', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: { items: [messageEntry()], deltaLink: 'next' },
    });
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'excluded',
      reason: 'marketing',
      category: 'marketing',
      matchedRuleId: 'rule-1',
      senderKey: null,
      needsReview: false,
    });

    const result = await runSubscriptionSync('tenant-1', access(), row());

    expect(result).toEqual({ changed: 0, removed: 0 });
    expect(mockIngestObjectChunks).not.toHaveBeenCalled();
    expect(mockDeleteObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      'microsoft',
      'alice@example.com/msg/msg-1'
    );
  });

  it('indexes a matched system-notification extraction with template metadata', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: { items: [messageEntry()], deltaLink: 'next' },
    });
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'index',
      content: 'jira notification\nissueKey: PROJ-1',
      category: 'system_notification',
      matchedRuleId: 'rule-2',
      senderKey: 'jira',
      templateId: 'tpl-1',
      templateVersion: 3,
      matchScore: 0.95,
      needsReview: false,
    });

    await runSubscriptionSync('tenant-1', access(), row());

    expect(mockIngestObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ senderKey: 'jira', templateVersion: 3 }),
      })
    );
  });

  it('still indexes (via the generic cleaner) when the sender has drifted, flagged for review', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: true,
      val: { items: [messageEntry()], deltaLink: 'next' },
    });
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'index',
      content: 'Subject: Hello\n\nJust checking in.',
      category: 'system_notification',
      matchedRuleId: 'rule-2',
      senderKey: 'jira',
      templateId: 'tpl-1',
      templateVersion: 3,
      matchScore: 0.4,
      needsReview: true,
    });

    const result = await runSubscriptionSync('tenant-1', access(), row());

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockIngestObjectChunks).toHaveBeenCalled();
  });

  it('leaves event/task kinds on the original contentOf path, untouched by the sanitizer', async () => {
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
    });

    expect(result).toEqual({ changed: 1, removed: 0 });
    expect(mockSanitizeEmailForTenant).not.toHaveBeenCalled();
    expect(mockIngestObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({ content: expect.stringContaining('Event: Standup') })
    );
  });
});
