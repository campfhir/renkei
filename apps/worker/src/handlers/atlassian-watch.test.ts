/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Polling correctness, where the failure mode is silence: a watermark that
 * advances past unprocessed items loses that content permanently, and
 * nothing errors. These assert the two things that prevent it — the overlap
 * window on the query, and the cursor being derived from what was actually
 * ingested rather than from "now".
 *
 * The Atlassian client is left real and `fetch` is stubbed instead, so the
 * JQL and the v2 query string are asserted exactly as they go on the wire.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
  ingestObjectChunks: jest.fn(),
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import { runWatchSync } from './atlassian-watch';
import type { AtlassianAccess } from './atlassian-access';
import type { WatchRow } from './atlassian-watch';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const {
  resolveEmbeddingProvider: mockResolveEmbeddingProvider,
  ingestObjectChunks: mockIngestObjectChunks,
} = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
  ingestObjectChunks: jest.Mock;
}>('@renkei/knowledge');

interface FetchCall {
  url: string;
  body: Record<string, unknown> | null;
}

let calls: FetchCall[] = [];
let responses: (Record<string, unknown> | null)[] = [];
/** What the sync wrote back to content_watches on its final update. */
let written: Record<string, unknown> | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  calls = [];
  responses = [];
  written = null;

  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      updateTable: () => ({
        set: (values: Record<string, unknown>) => {
          written = values;
          return { where: () => ({ execute: async () => [] }) };
        },
      }),
    },
  });
  mockResolveEmbeddingProvider.mockResolvedValue({ embed: async () => [[0.1]] });
  mockIngestObjectChunks.mockResolvedValue(ok(1));

  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const next = responses.shift();
    if (next === null || next === undefined) {
      return { ok: false, status: 500, statusText: 'boom', text: async () => 'boom' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  }) as unknown as typeof fetch;
});

function access(): AtlassianAccess {
  return { accessToken: 'token-1', accountId: 'acct-1', cloudId: 'cloud-1' };
}

function jiraRow(cursor: string | null): WatchRow {
  return {
    id: 'watch-1',
    tenant_id: 'tenant-1',
    provider: 'jira',
    account_id: 'acct-1',
    scope_type: 'project',
    scope_key: 'ENG',
    cursor,
  };
}

function confluenceRow(cursor: string | null): WatchRow {
  return {
    id: 'watch-2',
    tenant_id: 'tenant-1',
    provider: 'confluence',
    account_id: 'acct-1',
    scope_type: 'space',
    scope_key: '55001',
    cursor,
  };
}

describe('runWatchSync — jira', () => {
  it('asks for the whole project on a first run, with no updated clause', async () => {
    responses = [{ issues: [] }];
    await runWatchSync('tenant-1', access(), jiraRow(null));
    const jql = String((calls[0]?.body ?? {}).jql);
    expect(jql).toContain('project = "ENG"');
    expect(jql).not.toContain('updated >=');
  });

  it('rewinds the window behind the cursor so eventually-consistent writes are not lost', async () => {
    responses = [{ issues: [] }];
    await runWatchSync('tenant-1', access(), jiraRow('2026-08-10T12:00:00.000Z'));
    const jql = String((calls[0]?.body ?? {}).jql);
    // Two minutes before the cursor, in Jira's own JQL timestamp format.
    expect(jql).toContain('updated >= "2026/08/10 11:58"');
    // And `updated` must lead, matching the ORDER BY.
    expect(jql.indexOf('updated >=')).toBeLessThan(jql.indexOf('project ='));
  });

  it('advances the cursor to the newest issue it actually ingested', async () => {
    responses = [
      {
        issues: [
          {
            key: 'ENG-1',
            fields: { summary: 'One', updated: '2026-08-10T09:00:00.000Z' },
          },
          {
            key: 'ENG-2',
            fields: { summary: 'Two', updated: '2026-08-10T10:00:00.000Z' },
          },
        ],
      },
    ];
    const result = await runWatchSync('tenant-1', access(), jiraRow(null));
    expect(result.items).toBe(2);
    expect(result.cursor).toBe('2026-08-10T10:00:00.000Z');
    expect(written?.cursor).toBe('2026-08-10T10:00:00.000Z');
    expect(written?.sync_status).toBe('idle');
  });

  it('does not advance the cursor past an item that failed to index', async () => {
    responses = [
      {
        issues: [
          { key: 'ENG-1', fields: { summary: 'Indexed', updated: '2026-08-10T09:00:00.000Z' } },
          { key: 'ENG-2', fields: { summary: 'Broken', updated: '2026-08-10T10:00:00.000Z' } },
        ],
      },
    ];
    mockIngestObjectChunks.mockResolvedValueOnce(ok(1)).mockResolvedValueOnce(err('EMBED_FAILED'));
    const result = await runWatchSync('tenant-1', access(), jiraRow(null));
    // The failure is skipped, not thrown — but the watermark stays behind it
    // so the next round re-reads it.
    expect(result.items).toBe(1);
    expect(result.cursor).toBe('2026-08-10T09:00:00.000Z');
  });

  it('throws on a provider failure rather than writing a cursor', async () => {
    responses = [null];
    await expect(runWatchSync('tenant-1', access(), jiraRow(null))).rejects.toThrow(
      /jira search failed/
    );
    expect(written).toBeNull();
  });

  it('does nothing when the org has no embedding provider configured', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    const result = await runWatchSync('tenant-1', access(), jiraRow('2026-08-10T12:00:00.000Z'));
    expect(calls).toHaveLength(0);
    expect(result.items).toBe(0);
    // The cursor is handed back untouched, not reset.
    expect(result.cursor).toBe('2026-08-10T12:00:00.000Z');
  });
});

describe('runWatchSync — confluence', () => {
  it('scopes to the space and asks newest-modified-first', async () => {
    responses = [{ results: [] }];
    await runWatchSync('tenant-1', access(), confluenceRow(null));
    expect(calls[0]?.url).toContain('/wiki/api/v2/pages?space-id=55001');
    expect(calls[0]?.url).toContain('sort=-modified-date');
  });

  it('stops walking once it reaches content older than the watermark', async () => {
    responses = [
      {
        results: [
          {
            id: '1',
            title: 'Fresh',
            version: { createdAt: '2026-08-10T12:00:00.000Z' },
            body: { atlas_doc_format: { value: '{"content":[{"text":"new"}]}' } },
          },
          {
            id: '2',
            title: 'Old',
            version: { createdAt: '2026-08-01T00:00:00.000Z' },
            body: { atlas_doc_format: { value: '{"content":[{"text":"old"}]}' } },
          },
        ],
        _links: { next: '/wiki/api/v2/pages?cursor=next' },
      },
      { results: [] },
    ];
    const result = await runWatchSync('tenant-1', access(), confluenceRow('2026-08-09T00:00:00Z'));
    expect(result.items).toBe(1);
    // The `next` link is never followed — everything past the watermark is
    // older by construction of the sort.
    expect(calls).toHaveLength(1);
    expect(result.cursor).toBe('2026-08-10T12:00:00.000Z');
  });

  it('flattens ADF to text for the embedder', async () => {
    responses = [
      {
        results: [
          {
            id: '9',
            title: 'Runbook',
            version: { createdAt: '2026-08-10T12:00:00.000Z' },
            body: {
              atlas_doc_format: {
                value: JSON.stringify({
                  content: [{ content: [{ text: 'restart' }, { text: 'the pod' }] }],
                }),
              },
            },
          },
        ],
      },
    ];
    await runWatchSync('tenant-1', access(), confluenceRow(null));
    const input = mockIngestObjectChunks.mock.calls[0]?.[2];
    expect(input.provider).toBe('confluence');
    expect(input.refId).toBe('9');
    expect(input.content).toBe('Runbook\n\nrestart the pod');
    expect(input.sourceAt).toBe('2026-08-10T12:00:00.000Z');
  });
});
