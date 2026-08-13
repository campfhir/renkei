/**
 * The message-override handler: a mailbox owner's own correction, applied by
 * re-fetching their one message from Graph (bodies are never persisted at
 * rest) and enqueuing it for the embedding queue with the override forced —
 * the sanitizer itself runs in the embedding worker (knowledge-ingest.ts).
 * 'exclude' is the one action that never re-fetches — there is nothing left
 * to sanitize, only a chunk removal to enqueue.
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
}));
jest.mock('../enqueue', () => ({ enqueueKnowledgeEvent: jest.fn() }));

import { ok, err } from '@campfhir/safe-functions/helpers';
import { createMicrosoftMessageOverrideHandler } from './microsoft-events';
import type { ClaimedEvent } from '../queue';

const { resolveMicrosoftAccess: mockResolveMicrosoftAccess } = jest.requireMock<{
  resolveMicrosoftAccess: jest.Mock;
}>('./microsoft-access');
const { graphRequest: mockGraphRequest } = jest.requireMock<{ graphRequest: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const { resolveEmbeddingProvider: mockResolveEmbeddingProvider } = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
}>('@renkei/knowledge');
const { enqueueKnowledgeEvent: mockEnqueueKnowledgeEvent } = jest.requireMock<{
  enqueueKnowledgeEvent: jest.Mock;
}>('../enqueue');

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
  mockEnqueueKnowledgeEvent.mockResolvedValue(undefined);
});

describe('createMicrosoftMessageOverrideHandler', () => {
  it('exclude never re-fetches Graph — it enqueues only the chunk removal', async () => {
    const handler = createMicrosoftMessageOverrideHandler();
    await handler(event({ action: 'exclude' }));

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'delete.object',
      { provider: 'microsoft', refId: 'alice@example.com/msg/msg-1' },
      'microsoft/alice@example.com/msg'
    );
  });

  it('reclassify re-fetches the message and enqueues it with the override riding along', async () => {
    mockGraphRequest.mockResolvedValue(
      ok({
        id: 'msg-1',
        subject: 'Hello',
        from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
        receivedDateTime: '2026-08-10T12:00:00Z',
        body: { contentType: 'text', content: 'Full body.' },
      })
    );

    const handler = createMicrosoftMessageOverrideHandler();
    await handler(event({ action: 'reclassify', category: 'human' }));

    expect(mockGraphRequest).toHaveBeenCalledWith('token', '/me/messages/msg-1');
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledWith(
      'tenant-1',
      'ingest.email',
      expect.objectContaining({
        provider: 'microsoft',
        refId: 'alice@example.com/msg/msg-1',
        ownerUpn: 'alice@example.com',
        override: { action: 'reclassify', category: 'human', senderKey: undefined },
        raw: expect.objectContaining({ subject: 'Hello', body: expect.anything() }),
        metadata: expect.objectContaining({ overridden: true, subject: 'Hello' }),
        sourceAt: '2026-08-10T12:00:00Z',
      }),
      // The mailbox-kind ordering key: index writes for one mailbox stay
      // serial across embedding workers.
      'microsoft/alice@example.com/msg'
    );
  });

  it('throws when the Graph re-fetch fails, so the retry budget applies', async () => {
    mockGraphRequest.mockResolvedValue(err('GRAPH_API_ERROR' as const));

    const handler = createMicrosoftMessageOverrideHandler();
    await expect(handler(event({ action: 'reclassify', category: 'human' }))).rejects.toThrow(
      'could not re-fetch message'
    );
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
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
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });
});
