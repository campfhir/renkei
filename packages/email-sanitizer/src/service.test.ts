/**
 * `sanitizeEmailForTenant`'s DB-touching behavior: dedup (exact-hash first,
 * then near-duplicate via embedding cosine similarity when an embedder is
 * supplied) and that the classification log always gets written. The pure
 * routing itself is covered by the pipeline fixtures — this only tests the
 * wrapper's own decisions.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => ({ execute: async () => ({ rows: [] }) }) }));
jest.mock('@renkei/knowledge', () => ({
  vectorLiteral: (vector: number[]) => `[${vector.join(',')}]`,
}));
jest.mock('./persistence/rules', () => ({ listClassifierRules: jest.fn() }));
jest.mock('./persistence/templates', () => ({ listActiveTemplates: jest.fn() }));
jest.mock('./persistence/log', () => ({
  hasRecentDuplicate: jest.fn(),
  recordClassification: jest.fn(),
}));
jest.mock('./persistence/similarity', () => ({ hasNearDuplicateChunk: jest.fn() }));
jest.mock('./persistence/scripts', () => ({
  listActiveCleanerScripts: jest.fn(),
  recordCleanerScriptError: jest.fn(),
}));

import { ok } from '@campfhir/safe-functions/helpers';
import { sanitizeEmailForTenant } from './service';
import type { RawEmail } from './types';

const { listClassifierRules: mockListClassifierRules } = jest.requireMock<{
  listClassifierRules: jest.Mock;
}>('./persistence/rules');
const { listActiveTemplates: mockListActiveTemplates } = jest.requireMock<{
  listActiveTemplates: jest.Mock;
}>('./persistence/templates');
const {
  hasRecentDuplicate: mockHasRecentDuplicate,
  recordClassification: mockRecordClassification,
} = jest.requireMock<{ hasRecentDuplicate: jest.Mock; recordClassification: jest.Mock }>(
  './persistence/log'
);
const { hasNearDuplicateChunk: mockHasNearDuplicateChunk } = jest.requireMock<{
  hasNearDuplicateChunk: jest.Mock;
}>('./persistence/similarity');
const { listActiveCleanerScripts: mockListActiveCleanerScripts } = jest.requireMock<{
  listActiveCleanerScripts: jest.Mock;
}>('./persistence/scripts');

function humanEmail(): RawEmail {
  return {
    subject: 'Hello',
    fromName: 'Bob',
    fromAddress: 'bob@example.com',
    receivedAt: '2026-08-10T12:00:00Z',
    body: { content: 'Just checking in.', contentType: 'text' },
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockListClassifierRules.mockResolvedValue(ok([]));
  mockListActiveTemplates.mockResolvedValue(ok(new Map()));
  mockListActiveCleanerScripts.mockResolvedValue(ok([]));
  mockRecordClassification.mockResolvedValue(ok());
});

describe('sanitizeEmailForTenant — dedup', () => {
  /**
   * The scoping arguments are the whole defence against a re-index pass
   * deleting the mailbox it was asked to refresh: an already-indexed
   * message finds its own chunk at distance 0, declares itself a
   * duplicate, and gets removed — every step reporting success.
   */
  it('never compares a message against itself, or against another mailbox', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));
    mockHasNearDuplicateChunk.mockResolvedValue(ok(false));

    await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
      embedder: { embed: async () => ok([[0.1, 0.2]]) },
    });

    expect(mockHasRecentDuplicate).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      expect.any(Number),
      { ownerUpn: 'bob@example.com', refId: 'bob@example.com/msg/1' }
    );
    expect(mockHasNearDuplicateChunk).toHaveBeenCalledWith('tenant-1', expect.any(String), {
      refId: 'bob@example.com/msg/1',
      // Mail compares only against this mailbox's own mail — not a
      // colleague's, and not calendar or task chunks from the same tenant.
      refIdPrefix: 'bob@example.com/msg/',
    });
  });

  it('runs cleaner scripts over the body, never the header', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));
    mockListActiveCleanerScripts.mockResolvedValue(
      ok([
        {
          id: 'script-1',
          name: 'shout',
          script: '(email) => email.text.toUpperCase()',
          enabled: true,
          lastError: null,
        },
      ])
    );

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
    });

    expect(result.action).toBe('index');
    if (result.action === 'index') {
      // Body transformed by the real sandbox; the metadata header intact.
      expect(result.content).toContain('JUST CHECKING IN.');
      expect(result.content).toContain('Subject: Hello');
      expect(result.content).not.toContain('SUBJECT: HELLO');
    }
  });

  it('passes text through unchanged when a script fails, recording the error', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));
    mockListActiveCleanerScripts.mockResolvedValue(
      ok([
        {
          id: 'script-1',
          name: 'broken',
          script: "() => { throw new Error('boom'); }",
          enabled: true,
          lastError: null,
        },
      ])
    );
    const { recordCleanerScriptError: mockRecordError } = jest.requireMock<{
      recordCleanerScriptError: jest.Mock;
    }>('./persistence/scripts');

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
    });

    expect(result.action).toBe('index');
    if (result.action === 'index') expect(result.content).toContain('Just checking in.');
    expect(mockRecordError).toHaveBeenCalledWith(
      'tenant-1',
      'script-1',
      expect.stringContaining('boom')
    );
  });

  it('indexes normally when nothing is a duplicate', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
    });

    expect(result.action).toBe('index');
    expect(mockHasNearDuplicateChunk).not.toHaveBeenCalled();
  });

  it('excludes as a duplicate on an exact-hash match, without ever checking near-duplicates', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(true));

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
      embedder: { embed: jest.fn() },
    });

    expect(result).toMatchObject({ action: 'excluded', reason: 'duplicate' });
    expect(mockHasNearDuplicateChunk).not.toHaveBeenCalled();
  });

  it('skips the near-duplicate check entirely when no embedder is supplied', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
    });

    expect(result.action).toBe('index');
    expect(mockHasNearDuplicateChunk).not.toHaveBeenCalled();
  });

  it('excludes as a duplicate when the embedding is a near-duplicate of something already indexed', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));
    mockHasNearDuplicateChunk.mockResolvedValue(ok(true));
    const embed = jest.fn().mockResolvedValue(ok([[0.1, 0.2, 0.3]]));

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
      embedder: { embed },
    });

    expect(embed).toHaveBeenCalledWith([expect.stringContaining('Just checking in.')]);
    expect(mockHasNearDuplicateChunk).toHaveBeenCalledWith(
      'tenant-1',
      '[0.1,0.2,0.3]',
      expect.objectContaining({ refId: 'bob@example.com/msg/1' })
    );
    expect(result).toMatchObject({ action: 'excluded', reason: 'duplicate' });
  });

  it('indexes normally when the embedder is supplied but finds no near-duplicate', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));
    mockHasNearDuplicateChunk.mockResolvedValue(ok(false));
    const embed = jest.fn().mockResolvedValue(ok([[0.1, 0.2, 0.3]]));

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
      embedder: { embed },
    });

    expect(result.action).toBe('index');
  });

  it('degrades to exact-hash-only dedup when the embed call itself fails', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(false));
    const embed = jest.fn().mockResolvedValue({ ok: false, err: { type: 'EMBEDDING_FAILED' } });

    const result = await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
      embedder: { embed },
    });

    expect(mockHasNearDuplicateChunk).not.toHaveBeenCalled();
    expect(result.action).toBe('index');
  });

  it('always records the classification, even when excluded as a duplicate', async () => {
    mockHasRecentDuplicate.mockResolvedValue(ok(true));

    await sanitizeEmailForTenant({
      tenantId: 'tenant-1',
      provider: 'microsoft',
      refId: 'bob@example.com/msg/1',
      ownerUpn: 'bob@example.com',
      raw: humanEmail(),
    });

    expect(mockRecordClassification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        result: expect.objectContaining({ action: 'excluded' }),
      })
    );
  });
});
