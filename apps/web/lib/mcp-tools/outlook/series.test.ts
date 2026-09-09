/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Recurring events across the calendar tools: the list and the get name
 * the series an occurrence belongs to, and outlook_update_event changes
 * one occurrence alone, or the whole series when the repeat itself
 * changes — sending the PATCH to the series master, whichever id the
 * model held.
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

const MASTER = {
  id: 'evt-master',
  subject: 'Rachel Cheng / Scott 1:1',
  type: 'seriesMaster',
  start: { dateTime: '2026-09-16T11:00:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-09-16T11:30:00', timeZone: 'America/Los_Angeles' },
  organizer: { emailAddress: { name: 'Scott', address: 'scott@example.com' } },
  isOrganizer: true,
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'] },
    range: { type: 'noEnd', startDate: '2026-09-16' },
  },
  body: { content: 'Weekly 1:1' },
};
const OCCURRENCE = {
  ...MASTER,
  id: 'evt-occ-3',
  type: 'occurrence',
  seriesMasterId: 'evt-master',
  start: { dateTime: '2026-09-30T11:00:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-09-30T11:30:00', timeZone: 'America/Los_Angeles' },
  recurrence: null,
};
const SINGLE = {
  id: 'evt-single',
  subject: 'Lunch',
  type: 'singleInstance',
  start: { dateTime: '2026-09-17T12:00:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-09-17T13:00:00', timeZone: 'America/Los_Angeles' },
  isOrganizer: true,
};

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
    const path = String(url);
    const body =
      method !== 'GET'
        ? {}
        : path.includes('/calendarView')
          ? { value: [OCCURRENCE, SINGLE] }
          : path.includes('/me/events/evt-master')
            ? MASTER
            : path.includes('/me/events/evt-occ-3')
              ? OCCURRENCE
              : SINGLE;
    return {
      ok: true,
      status: method === 'GET' ? 200 : 204,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
});

async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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
  const handler = registered.get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';

describe('outlook_list_events', () => {
  it('asks Graph for the series fields and names the series an occurrence belongs to', async () => {
    const result = await tool('outlook_list_events', {});
    expect(requests[0].url).toContain('type,seriesMasterId');
    expect(text(result)).toContain('one occurrence of a series (series id: evt-master)');
    expect(text(result)).toContain('Lunch');
  });
});

describe('outlook_get_event', () => {
  it('says how a series repeats', async () => {
    const result = await tool('outlook_get_event', { eventId: 'evt-master' });
    expect(requests[0].url).toContain('recurrence');
    expect(text(result)).toContain('a recurring series');
    expect(text(result)).toContain('Repeats: every week on Wednesday');
  });

  it('points an occurrence at its series without claiming it repeats itself', async () => {
    const result = await tool('outlook_get_event', { eventId: 'evt-occ-3' });
    expect(text(result)).toContain('series id: evt-master');
    expect(text(result)).not.toContain('Repeats:');
  });
});

describe('outlook_update_event', () => {
  it('changes one occurrence alone by default', async () => {
    const result = await tool('outlook_update_event', {
      eventId: 'evt-occ-3',
      start: '2026-09-30T14:00:00',
      end: '2026-09-30T14:30:00',
    });
    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PATCH']);
    expect(requests[1].url).toContain('/me/events/evt-occ-3');
    expect(requests[1].body).toEqual({
      start: { dateTime: '2026-09-30T14:00:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-09-30T14:30:00', timeZone: 'America/Los_Angeles' },
    });
    expect(text(result)).toContain('this occurrence only');
  });

  it('sends a new repeat to the series master, with the range on the series’ own start', async () => {
    const result = await tool('outlook_update_event', {
      eventId: 'evt-occ-3',
      recurrence: { frequency: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'] },
    });
    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(requests[1].url).toContain('/me/events/evt-master');
    expect(requests[2].url).toContain('/me/events/evt-master');
    expect(requests[2].body).toEqual({
      recurrence: {
        pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'] },
        range: {
          type: 'noEnd',
          startDate: '2026-09-16',
          recurrenceTimeZone: 'America/Los_Angeles',
        },
      },
    });
    expect(text(result)).toContain('the whole series');
    expect(text(result)).toContain('now repeats every other week on Monday and Wednesday');
  });

  it('scope "series" sends an ordinary change to the master too', async () => {
    await tool('outlook_update_event', {
      eventId: 'evt-occ-3',
      scope: 'series',
      location: 'Room 2',
    });
    expect(requests[2].url).toContain('/me/events/evt-master');
    expect(requests[2].body).toEqual({ location: { displayName: 'Room 2' } });
  });

  it('stopRepeating clears the recurrence on the master', async () => {
    const result = await tool('outlook_update_event', {
      eventId: 'evt-master',
      stopRepeating: true,
    });
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PATCH']);
    expect(requests[1].body).toEqual({ recurrence: null });
    expect(text(result)).toContain('no longer repeats');
  });

  it('makes a single event recurring', async () => {
    await tool('outlook_update_event', {
      eventId: 'evt-single',
      recurrence: '{"frequency":"monthly","occurrences":"3"}',
    });
    expect(requests[1].body).toMatchObject({
      recurrence: {
        pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 17 },
        range: { type: 'numbered', startDate: '2026-09-17', numberOfOccurrences: 3 },
      },
    });
  });

  it('refuses an empty change, a contradictory one, and a bad repeat before calling Graph', async () => {
    const empty = await tool('outlook_update_event', { eventId: 'evt-single' });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain('Nothing to change');

    const both = await tool('outlook_update_event', {
      eventId: 'evt-single',
      recurrence: { frequency: 'daily' },
      stopRepeating: true,
    });
    expect(both.isError).toBe(true);

    const bad = await tool('outlook_update_event', {
      eventId: 'evt-single',
      recurrence: { frequency: 'fortnightly' },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('recurrence.frequency');
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });
});
