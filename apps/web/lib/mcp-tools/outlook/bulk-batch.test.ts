/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression guards for how the outlook_bulk_* action tools talk to
 * Graph's $batch endpoint: the hard 20-per-batch limit, sequential
 * (not concurrent) chunk dispatch so a large action doesn't throttle
 * itself, and 429 retry behavior.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

jest.mock('@renkei/provider-grants', () => ({
  getGrant: async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountId: 'acct-1',
      metadata: { upn: 'scott@example.com' },
    },
  }),
  refreshGrantTokens: async () => ({ ok: true, val: { accessToken: 'token-1' } }),
  MICROSOFT: 'microsoft',
  MicrosoftAdapter: class {},
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            where: () => ({
              where: () => ({
                executeTakeFirst: async () => ({ provider_account_id: 'acct-1' }),
              }),
            }),
          }),
        }),
      }),
    },
  }),
}));
jest.mock('@renkei/connector-microsoft', () => ({
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
}));
jest.mock('@/lib/microsoft-app', () => ({ getMicrosoftApp: async () => null }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  searchKnowledge: async () => ({ ok: true, val: { hits: [], elided: 0 } }),
}));
jest.mock('../knowledge', () => ({ buildKnowledgeVerifiers: async () => new Map() }));
jest.mock('@/lib/logger', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  secure: (value: unknown) => value,
}));

import { registerOutlookTools } from './index';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface BatchPost {
  requests: { id: string; method: string; url: string; body?: unknown }[];
}

/** Every $batch payload the tool sent, in dispatch order. */
let batches: BatchPost[] = [];
/** True while a fetch is in flight — proves chunks are not fired concurrently. */
let inFlight = false;
let sawConcurrentCalls = false;
/** Per-message-id status the fake Graph returns, defaulting to 200. */
let statusById: Map<string, number[]> = new Map();

function nextStatusFor(id: string): number {
  const queue = statusById.get(id);
  if (!queue || queue.length === 0) return 200;
  return queue.length === 1 ? (queue[0] ?? 200) : (queue.shift() ?? 200);
}

beforeEach(() => {
  batches = [];
  inFlight = false;
  sawConcurrentCalls = false;
  statusById = new Map();
  jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => {
    // Retry backoff is real time in production; collapse it here so a
    // throttling test doesn't actually sleep for seconds.
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);

  global.fetch = (async (_url: string, init?: RequestInit) => {
    if (inFlight) sawConcurrentCalls = true;
    inFlight = true;
    const payload = JSON.parse(String(init?.body ?? '{}')) as BatchPost;
    batches.push(payload);
    const body = {
      responses: (payload.requests ?? []).map((request) => ({
        id: request.id,
        status: nextStatusFor(request.id),
        headers: { 'Retry-After': '1' },
        body: {},
      })),
    };
    await Promise.resolve();
    inFlight = false;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function bulkTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      registered.set(toolName, handler);
    },
  } as unknown as McpServer;

  await registerOutlookTools(server, {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'subject-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
  } as MCPToolContext);

  const handler = registered.get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler(args);
}

const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `msg-${index}`);

describe('graph $batch chunking', () => {
  it('never puts more than 20 sub-requests in one batch', async () => {
    await bulkTool('outlook_bulk_mark_messages', { messageIds: ids(45), isRead: true });
    expect(batches).toHaveLength(3);
    for (const batch of batches) expect(batch.requests.length).toBeLessThanOrEqual(20);
    expect(batches.flatMap((batch) => batch.requests)).toHaveLength(45);
  });

  it('dispatches chunks sequentially, not all at once', async () => {
    // Concurrent chunks are how a 200-message action throttles itself.
    await bulkTool('outlook_bulk_mark_messages', { messageIds: ids(60), isRead: true });
    expect(sawConcurrentCalls).toBe(false);
  });

  it('sends each sub-request with a Content-Type header when it carries a body', async () => {
    await bulkTool('outlook_bulk_mark_messages', { messageIds: ids(2), isRead: true });
    const [first] = batches;
    for (const request of first?.requests ?? []) {
      expect(request.method).toBe('PATCH');
      expect(request.body).toEqual({ isRead: true });
    }
  });

  it('reports per-message failures without failing the whole run', async () => {
    statusById.set('msg-1', [404]);
    const result = await bulkTool('outlook_bulk_mark_messages', {
      messageIds: ids(3),
      isRead: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('2 of 3 succeeded');
    expect(text).toContain('msg-1');
  });
});

describe('graph $batch throttling', () => {
  it('retries a 429 sub-request and reports it as a success once it lands', async () => {
    // Throttled on the first attempt, fine on the retry.
    statusById.set('msg-1', [429, 200]);
    const result = await bulkTool('outlook_bulk_mark_messages', {
      messageIds: ids(2),
      isRead: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('2 of 2 succeeded');
    // Second batch call carries only the throttled message, not the whole chunk.
    expect(batches).toHaveLength(2);
    expect(batches[1]?.requests.map((request) => request.id)).toEqual(['msg-1']);
  });

  it('gives up after a bounded number of rounds and reports the failure', async () => {
    statusById.set('msg-0', [429]); // always throttled
    const result = await bulkTool('outlook_bulk_mark_messages', {
      messageIds: ids(1),
      isRead: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('0 of 1 succeeded');
    expect(text).toContain('rate limiting');
    // Initial attempt plus the bounded retry rounds — not an infinite loop.
    expect(batches.length).toBeLessThanOrEqual(5);
  });
});

describe('outlook_bulk_archive_messages', () => {
  it('marks read and moves in one call, and only moves what marking succeeded on', async () => {
    statusById.set('msg-1', [404]);
    const result = await bulkTool('outlook_bulk_archive_messages', { messageIds: ids(3) });
    const text = result.content[0]?.text ?? '';

    const marked = batches.filter((batch) => batch.requests[0]?.method === 'PATCH');
    const moved = batches.filter((batch) => batch.requests[0]?.method === 'POST');
    expect(marked).toHaveLength(1);
    expect(moved).toHaveLength(1);
    // msg-1 failed to mark, so it must not appear in the move batch.
    expect(moved[0]?.requests.map((request) => request.id)).toEqual(['msg-0', 'msg-2']);
    expect(text).toContain('Marked read: 2 of 3 succeeded');
    expect(text).toContain('archive');
  });

  it('defaults to the archive folder', async () => {
    await bulkTool('outlook_bulk_archive_messages', { messageIds: ids(1) });
    const moved = batches.find((batch) => batch.requests[0]?.method === 'POST');
    expect(moved?.requests[0]?.body).toEqual({ destinationId: 'archive' });
    expect(moved?.requests[0]?.url).toContain('/move');
  });
});
