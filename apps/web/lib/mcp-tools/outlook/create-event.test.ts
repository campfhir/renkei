/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * outlook_create_event: a recurrence rides to Graph as patternedRecurrence,
 * a bad one is refused before any request is made, and the reply says how
 * the series repeats.
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
    const body = { id: 'evt-1', subject: 'Rachel Cheng / Scott 1:1', webLink: 'https://o/1' };
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
});

async function createEvent(args: Record<string, unknown>): Promise<ToolResult> {
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

  const handler = registered.get('outlook_create_event');
  if (!handler) throw new Error('outlook_create_event was not registered');
  return handler(args);
}

const baseArgs = {
  subject: 'Rachel Cheng / Scott 1:1',
  start: '2026-09-16T11:00:00',
  end: '2026-09-16T11:30:00',
  timezone: 'America/Los_Angeles',
  requiredAttendees: ['rachel.cheng@nems.org'],
};

describe('outlook_create_event recurrence', () => {
  it('sends no recurrence for a one-off event', async () => {
    const result = await createEvent(baseArgs);
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).not.toHaveProperty('recurrence');
    expect(result.content[0]?.text).not.toContain('repeating');
  });

  it('posts a weekly series to Graph and says so in the reply', async () => {
    const result = await createEvent({
      ...baseArgs,
      recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: ['Wednesday'] },
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe('https://graph.microsoft.com/v1.0/me/events');
    expect(requests[0]?.body).toMatchObject({
      subject: 'Rachel Cheng / Scott 1:1',
      start: { dateTime: '2026-09-16T11:00:00', timeZone: 'America/Los_Angeles' },
      attendees: [{ emailAddress: { address: 'rachel.cheng@nems.org' }, type: 'required' }],
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'] },
        range: {
          type: 'noEnd',
          startDate: '2026-09-16',
          recurrenceTimeZone: 'America/Los_Angeles',
        },
      },
    });
    expect(result.content[0]?.text).toContain('repeating every week on Wednesday');
  });

  it('takes the recurrence as JSON text too, and an interval', async () => {
    const result = await createEvent({
      ...baseArgs,
      recurrence:
        '{"frequency":"weekly","interval":2,"daysOfWeek":["wednesday"],"until":"2026-12-16"}',
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.body).toMatchObject({
      recurrence: {
        pattern: { type: 'weekly', interval: 2 },
        range: { type: 'endDate', endDate: '2026-12-16' },
      },
    });
    expect(result.content[0]?.text).toContain('every other week on Wednesday until 2026-12-16');
  });

  it('refuses a bad recurrence by field name before calling Graph', async () => {
    const result = await createEvent({
      ...baseArgs,
      recurrence: { frequency: 'weekly', interval: 'sometimes' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('recurrence.interval');
    expect(requests).toHaveLength(0);
  });
});
