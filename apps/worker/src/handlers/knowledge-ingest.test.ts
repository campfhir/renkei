/**
 * The embedding queue's handlers: failure THROWS (these jobs own only
 * idempotent index writes, so retry is safe — the inversion of the old
 * inline log-and-continue), a missing provider completes quietly (knowledge
 * off is never an error), and the enrich.item back-fill touches only the
 * two enrichment keys and only while the item is still 'suggested'.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: jest.fn(() => 'sql-fragment') }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
  ingestObjectChunks: jest.fn(),
  deleteObjectChunks: jest.fn(),
  searchKnowledge: jest.fn(),
}));
jest.mock('@renkei/email-sanitizer', () => ({ sanitizeEmailForTenant: jest.fn() }));
jest.mock('@renkei/connector-webex', () => ({ createWebexAccessVerifier: jest.fn() }));
jest.mock('./webex-context', () => ({ resolveWebexContext: jest.fn() }));

import { ok, err } from '@campfhir/safe-functions/helpers';
import {
  createKnowledgeIngestObjectHandler,
  createKnowledgeIngestEmailHandler,
  createKnowledgeDeleteObjectHandler,
  createKnowledgePurgePrefixHandler,
  createKnowledgeEnrichItemHandler,
} from './knowledge-ingest';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const {
  resolveEmbeddingProvider: mockResolveEmbeddingProvider,
  ingestObjectChunks: mockIngestObjectChunks,
  deleteObjectChunks: mockDeleteObjectChunks,
  searchKnowledge: mockSearchKnowledge,
} = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
  ingestObjectChunks: jest.Mock;
  deleteObjectChunks: jest.Mock;
  searchKnowledge: jest.Mock;
}>('@renkei/knowledge');
const { sanitizeEmailForTenant: mockSanitizeEmailForTenant } = jest.requireMock<{
  sanitizeEmailForTenant: jest.Mock;
}>('@renkei/email-sanitizer');
const { resolveWebexContext: mockResolveWebexContext } = jest.requireMock<{
  resolveWebexContext: jest.Mock;
}>('./webex-context');

function event(type: string, payload: Record<string, unknown>): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'knowledge',
    type,
    // The same round-trip the real queue's jsonb column performs.
    payload: JSON.parse(JSON.stringify(payload)),
    attempts: 1,
  };
}

/** The narrow update chain enrich.item runs; records where-clauses and set values. */
function stubUpdateDb(capture: { wheres: unknown[][]; sets: Record<string, unknown>[] }): void {
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      updateTable: () => ({
        set: (values: Record<string, unknown>) => {
          capture.sets.push(values);
          return {
            where: function where(...args: unknown[]) {
              capture.wheres.push(args);
              return {
                where,
                executeTakeFirst: async () => ({ numUpdatedRows: BigInt(1) }),
              };
            },
          };
        },
      }),
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveEmbeddingProvider.mockResolvedValue({ embed: jest.fn() });
  mockIngestObjectChunks.mockResolvedValue(ok({ chunks: 1 }));
  mockDeleteObjectChunks.mockResolvedValue(ok());
});

describe('ingest.object', () => {
  const payload = {
    provider: 'zoom',
    refId: 'host@x.com/uuid/transcript',
    content: 'Meeting: standup\n\nnotes',
    metadata: { kind: 'transcript' },
    sourceAt: '2026-08-10T09:00:00Z',
    chunking: { maxChars: 4000, overlap: 400 },
  };

  it('ingests with the payload chunking options', async () => {
    await createKnowledgeIngestObjectHandler()(event('ingest.object', payload));
    expect(mockIngestObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({ provider: 'zoom', content: payload.content }),
      { maxChars: 4000, overlap: 400 }
    );
  });

  it('throws on an embedding failure so the queue retries it', async () => {
    mockIngestObjectChunks.mockResolvedValue(err('EMBEDDING_FAILED' as const));
    await expect(
      createKnowledgeIngestObjectHandler()(event('ingest.object', payload))
    ).rejects.toThrow('EMBEDDING_FAILED');
  });

  it('completes quietly when knowledge has been turned off since enqueue', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    await createKnowledgeIngestObjectHandler()(event('ingest.object', payload));
    expect(mockIngestObjectChunks).not.toHaveBeenCalled();
  });

  it('dead-letters (throws) on a malformed payload rather than ingesting garbage', async () => {
    await expect(
      createKnowledgeIngestObjectHandler()(event('ingest.object', { provider: 'zoom' }))
    ).rejects.toThrow("missing 'refId'");
  });
});

describe('ingest.email', () => {
  const payload = {
    provider: 'microsoft',
    refId: 'alice@example.com/msg/msg-1',
    ownerUpn: 'alice@example.com',
    accountId: 'acct-1',
    raw: {
      subject: 'Hello',
      fromName: 'Bob',
      fromAddress: 'bob@example.com',
      receivedAt: '2026-08-10T12:00:00Z',
      body: { content: 'Just checking in.', contentType: 'text' },
    },
    metadata: { kind: 'msg', subject: 'Hello' },
    sourceAt: '2026-08-10T12:00:00Z',
  };

  it('sanitizes with the embedder and ingests the cleaned content, reusing the near-dup vector', async () => {
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'index',
      content: 'Subject: Hello\n\nJust checking in.',
      category: 'human',
      matchedRuleId: null,
      senderKey: 'jira',
      templateId: null,
      templateVersion: 3,
      matchScore: null,
      needsReview: false,
      embedding: [0.5, 0.5],
    });

    await createKnowledgeIngestEmailHandler()(event('ingest.email', payload));

    expect(mockSanitizeEmailForTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: expect.objectContaining({ subject: 'Hello', fromAddress: 'bob@example.com' }),
        embedder: expect.anything(),
      })
    );
    expect(mockIngestObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({
        content: 'Subject: Hello\n\nJust checking in.',
        metadata: expect.objectContaining({ senderKey: 'jira', templateVersion: 3 }),
      }),
      {
        precomputed: {
          content: 'Subject: Hello\n\nJust checking in.',
          vector: [0.5, 0.5],
        },
      }
    );
  });

  it('clears the chunks instead of ingesting when the sanitizer excludes', async () => {
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'excluded',
      reason: 'marketing',
      category: 'marketing',
      matchedRuleId: 'rule-1',
      senderKey: null,
      needsReview: false,
    });

    await createKnowledgeIngestEmailHandler()(event('ingest.email', payload));

    expect(mockIngestObjectChunks).not.toHaveBeenCalled();
    expect(mockDeleteObjectChunks).toHaveBeenCalledWith(
      'tenant-1',
      'microsoft',
      'alice@example.com/msg/msg-1'
    );
  });

  it('withholds the embedder from the sanitizer when an override rides along', async () => {
    mockSanitizeEmailForTenant.mockResolvedValue({
      action: 'index',
      content: 'cleaned',
      category: 'human',
      matchedRuleId: null,
      senderKey: null,
      templateId: null,
      templateVersion: null,
      matchScore: null,
      needsReview: false,
    });

    await createKnowledgeIngestEmailHandler()(
      event('ingest.email', { ...payload, override: { action: 'reclassify', category: 'human' } })
    );

    // Near-duplicate dedup must not swallow a deliberate owner correction.
    expect(mockSanitizeEmailForTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        embedder: undefined,
        override: expect.objectContaining({ action: 'reclassify', category: 'human' }),
      })
    );
  });
});

describe('delete.object / purge.prefix', () => {
  it('deletes one object and throws on failure', async () => {
    await createKnowledgeDeleteObjectHandler()(
      event('delete.object', { provider: 'microsoft', refId: 'a@x.com/msg/1' })
    );
    expect(mockDeleteObjectChunks).toHaveBeenCalledWith('tenant-1', 'microsoft', 'a@x.com/msg/1');

    mockDeleteObjectChunks.mockResolvedValue(err('DB_ERROR' as const));
    await expect(
      createKnowledgeDeleteObjectHandler()(
        event('delete.object', { provider: 'microsoft', refId: 'a@x.com/msg/1' })
      )
    ).rejects.toThrow('could not delete');
  });

  it('purges by prefix', async () => {
    await createKnowledgePurgePrefixHandler()(
      event('purge.prefix', { provider: 'microsoft', refIdPrefix: 'a@x.com/msg/' })
    );
    expect(mockDeleteObjectChunks).toHaveBeenCalledWith('tenant-1', 'microsoft', 'a@x.com/msg/', {
      prefixOnly: true,
    });
  });
});

describe('enrich.item', () => {
  const payload = {
    itemId: 'item-1',
    provider: 'webex',
    refId: 'room-1:msg-1',
    query: 'the message text',
    accessSubject: 'alice@example.com',
  };

  beforeEach(() => {
    mockResolveWebexContext.mockResolvedValue({ client: {}, botPersonId: null });
    mockSearchKnowledge.mockResolvedValue(
      ok({
        hits: [
          {
            provider: 'webex',
            refId: 'room-1:msg-0',
            content: 'earlier related message',
            metadata: {},
            distance: 0.2,
            sourceAt: null,
          },
        ],
        elided: 1,
      })
    );
  });

  it('searches as the acting identity, excluding the message itself', async () => {
    const capture: { wheres: unknown[][]; sets: Record<string, unknown>[] } = {
      wheres: [],
      sets: [],
    };
    stubUpdateDb(capture);

    await createKnowledgeEnrichItemHandler()(event('enrich.item', payload));

    expect(mockSearchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: 'alice@example.com',
        query: 'the message text',
        k: 3,
        excludeRef: { provider: 'webex', refId: 'room-1:msg-1' },
      })
    );
    // The guard: id + tenant + status='suggested' — never a blanket update.
    expect(capture.wheres).toEqual([
      ['id', '=', 'item-1'],
      ['tenant_id', '=', 'tenant-1'],
      ['status', '=', 'suggested'],
    ]);
    // Only evidence (via jsonb_set) and updated_at are written.
    expect(Object.keys(capture.sets[0] ?? {}).sort()).toEqual(['evidence', 'updated_at']);
  });

  it('throws when the search fails so the back-fill retries', async () => {
    mockSearchKnowledge.mockResolvedValue(err('EMBEDDING_FAILED' as const));
    await expect(createKnowledgeEnrichItemHandler()(event('enrich.item', payload))).rejects.toThrow(
      'related-items search failed'
    );
  });

  it('does nothing without a query or an acting identity', async () => {
    await createKnowledgeEnrichItemHandler()(
      event('enrich.item', { ...payload, accessSubject: '' })
    );
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
  });

  it('completes quietly when knowledge has been turned off since enqueue', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    await createKnowledgeEnrichItemHandler()(event('enrich.item', payload));
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
  });
});
