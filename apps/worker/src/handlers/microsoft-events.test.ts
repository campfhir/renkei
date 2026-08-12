/**
 * The message-override handler: a mailbox owner's own correction, applied by
 * re-fetching their one message from Graph (bodies are never persisted at
 * rest) and re-running it through the sanitizer with the override forced.
 * 'exclude' is the one action that never re-fetches — there is nothing left
 * to sanitize, only a chunk to remove.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('./microsoft-access', () => ({ resolveMicrosoftAccess: jest.fn() }));
jest.mock('@renkei/connector-microsoft', () => ({
  renewGraphSubscription: jest.fn(),
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

import { ok, err } from '@campfhir/safe-functions/helpers';
import { createMicrosoftMessageOverrideHandler } from './microsoft-events';
import type { ClaimedEvent } from '../queue';

const { resolveMicrosoftAccess: mockResolveMicrosoftAccess } = jest.requireMock<{
  resolveMicrosoftAccess: jest.Mock;
}>('./microsoft-access');
const { graphRequest: mockGraphRequest } = jest.requireMock<{ graphRequest: jest.Mock }>(
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

function event(override: { action: string; category?: string; senderKey?: string }): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'microsoft',
    type: 'message-override',
    payload: {
      accountId: 'acct-1',
      objectId: 'msg-1',
      refId: 'alice@example.com/msg/msg-1',
      override,
    },
    attempts: 1,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockResolveMicrosoftAccess.mockResolvedValue({
    accountId: 'acct-1',
    accessToken: 'token',
    upn: 'alice@example.com',
    scopes: ['Mail.Read'],
  });
  mockResolveEmbeddingProvider.mockResolvedValue({ embed: jest.fn() });
  mockIngestObjectChunks.mockResolvedValue(ok({ chunks: 1 }));
  mockDeleteObjectChunks.mockResolvedValue(ok());
});

describe('createMicrosoftMessageOverrideHandler', () => {
  it('exclude never re-fetches Graph — it only removes the existing chunk', async () => {
    const handler = createMicrosoftMessageOverrideHandler();
    await handler(event({ action: 'exclude' }));

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockSanitizeEmailForTenant).not.toHaveBeenCalled();
    expect(mockDeleteObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      'microsoft',
      'alice@example.com/msg/msg-1'
    );
  });

  it('reclassify re-fetches the message and indexes whatever the sanitizer returns for the corrected category', async () => {
    mockGraphRequest.mockResolvedValue(
      ok({
        id: 'msg-1',
        subject: 'Hello',
        from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
        receivedDateTime: '2026-08-10T12:00:00Z',
        body: { contentType: 'text', content: 'Full body.' },
      })
    );
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'index',
      content: 'Subject: Hello\n\nFull body.',
      category: 'human',
      matchedRuleId: null,
      senderKey: null,
      templateId: null,
      templateVersion: null,
      matchScore: null,
      needsReview: false,
    });

    const handler = createMicrosoftMessageOverrideHandler();
    await handler(event({ action: 'reclassify', category: 'human' }));

    expect(mockSanitizeEmailForTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        override: { action: 'reclassify', category: 'human', senderKey: undefined },
      })
    );
    expect(mockIngestObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({ content: 'Subject: Hello\n\nFull body.' })
    );
  });

  it('reclassify forwards the chosen category/senderKey and removes the chunk if the result excludes it', async () => {
    mockGraphRequest.mockResolvedValue(
      ok({ id: 'msg-1', subject: 'Notice', body: { contentType: 'text', content: 'Some notice.' } })
    );
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'excluded',
      reason: 'marketing',
      category: 'marketing',
      matchedRuleId: null,
      senderKey: null,
      needsReview: false,
    });

    const handler = createMicrosoftMessageOverrideHandler();
    await handler(event({ action: 'reclassify', category: 'marketing' }));

    expect(mockSanitizeEmailForTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        override: { action: 'reclassify', category: 'marketing', senderKey: undefined },
      })
    );
    expect(mockIngestObjectChunks).not.toHaveBeenCalled();
    expect(mockDeleteObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      'microsoft',
      'alice@example.com/msg/msg-1'
    );
  });

  it('throws when the Graph re-fetch fails, so the retry budget applies', async () => {
    mockGraphRequest.mockResolvedValue(err('GRAPH_API_ERROR' as const));

    const handler = createMicrosoftMessageOverrideHandler();
    await expect(handler(event({ action: 'reclassify', category: 'human' }))).rejects.toThrow(
      'could not re-fetch message'
    );
  });

  it('throws on an unknown override action', async () => {
    const handler = createMicrosoftMessageOverrideHandler();
    await expect(handler(event({ action: 'delete-everything' }))).rejects.toThrow(
      'no valid override.action'
    );
  });

  it('skips silently when the knowledge layer is off for this org', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);

    const handler = createMicrosoftMessageOverrideHandler();
    await handler(event({ action: 'reclassify', category: 'human' }));

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockSanitizeEmailForTenant).not.toHaveBeenCalled();
  });
});
