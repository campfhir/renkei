/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * outlook_find_meeting_times: durationMinutes must accept a numeric string
 * ("30") as readily as a number, since models frequently send JSON-numeric
 * fields as strings.
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
                limit: () => ({
                  executeTakeFirst: async () => ({ provider_account_id: 'acct-1' }),
                }),
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
  BATCH_CHUNK_SIZE: 20,
  graphBatch: jest.requireActual('@renkei/connector-microsoft/src/mail-batch').graphBatch,
  summarizeBatch: jest.requireActual('@renkei/connector-microsoft/src/mail-batch').summarizeBatch,
  withCategoryChanges: jest.requireActual('@renkei/connector-microsoft/src/mail-batch')
    .withCategoryChanges,
  buildMailQueryPath: jest.requireActual('@renkei/connector-microsoft/src/mail-filter')
    .buildMailQueryPath,
}));
jest.mock('@/lib/microsoft-app', () => ({ getMicrosoftApp: async () => null }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  resolveKnowledge: async () => null,
  searchKnowledge: async () => ({ ok: true, val: { hits: [], elided: 0 } }),
}));
jest.mock('../knowledge', () => ({ buildKnowledgeVerifiers: async () => new Map() }));
jest.mock('@/lib/logger', () => ({
  logger: {
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  secure: (value: unknown) => value,
}));

import { registerOutlookTools } from './index';
import { oauthGraphAuth } from '../graph/graph-auth';

type ToolResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

let requests: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
  requests = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body = { meetingTimeSuggestions: [] };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
});

async function findMeetingTimes(args: Record<string, unknown>): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      registered.set(toolName, handler);
    },
  } as unknown as McpServer;

  const context = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'subject-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
  } as MCPToolContext;

  await registerOutlookTools(server, context, oauthGraphAuth(context));

  const handler = registered.get('outlook_find_meeting_times');
  if (!handler) throw new Error('outlook_find_meeting_times was not registered');
  return handler(args);
}

const baseArgs = {
  earliestStart: '2026-08-21T08:00:00',
  latestEnd: '2026-08-21T18:00:00',
};

describe('outlook_find_meeting_times durationMinutes', () => {
  it('accepts a number', async () => {
    const result = await findMeetingTimes({ ...baseArgs, durationMinutes: 30 });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.body).toMatchObject({ meetingDuration: 'PT30M' });
  });

  it('accepts a numeric string', async () => {
    const result = await findMeetingTimes({ ...baseArgs, durationMinutes: '30' });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.body).toMatchObject({ meetingDuration: 'PT30M' });
  });

  it('rejects a non-numeric string cleanly', async () => {
    const result = await findMeetingTimes({ ...baseArgs, durationMinutes: 'soon' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('durationMinutes');
    expect(requests).toHaveLength(0);
  });

  it('rejects an out-of-range numeric string', async () => {
    const result = await findMeetingTimes({ ...baseArgs, durationMinutes: '1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('between 5 and 1440');
    expect(requests).toHaveLength(0);
  });
});
