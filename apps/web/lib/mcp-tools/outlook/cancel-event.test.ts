/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The cancel-event preview/confirm pair: the preview only READS (the card
 * does the canceling), and the confirm re-checks the organizer role
 * server-side — organizer → POST /cancel (attendees get a cancellation),
 * anyone else → DELETE (their copy only). The role must come from Graph,
 * never from the card's pass-through args.
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
import { oauthGraphAuth } from '../graph/graph-auth';

type ToolResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Every Graph request the tools made, in order. */
let requests: { method: string; url: string; body: unknown }[] = [];
/** What the fake Graph says the user's role on the event is. */
let isOrganizer = true;

beforeEach(() => {
  requests = [];
  isOrganizer = true;
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body =
      method === 'GET'
        ? {
            id: 'evt-1',
            subject: 'Quarterly sync',
            start: { dateTime: '2026-08-21T10:00:00' },
            end: { dateTime: '2026-08-21T11:00:00' },
            organizer: { emailAddress: { name: 'Scott', address: 'scott@example.com' } },
            attendees: [{ emailAddress: { address: 'a@example.com' } }],
            location: { displayName: 'Room 4' },
            isOrganizer,
          }
        : {};
    return {
      ok: true,
      status: method === 'GET' ? 200 : 202,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
});

async function cancelTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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

describe('outlook_cancel_event_preview', () => {
  it('only reads, and stages the confirm tool on the card', async () => {
    const result = await cancelTool('outlook_cancel_event_preview', {
      eventId: 'evt-1',
      comment: 'Moving this to next week',
    });

    expect(requests.map((request) => request.method)).toEqual(['GET']);
    expect(result.structuredContent?.confirmTool).toBe('outlook_cancel_event_confirm');
    expect(result.structuredContent?.confirmArgs).toEqual({
      eventId: 'evt-1',
      comment: 'Moving this to next week',
    });
    expect(result.structuredContent?.title).toBe('Cancel event');
  });

  it('says the card removes (not cancels) when the user is not the organizer', async () => {
    isOrganizer = false;
    const result = await cancelTool('outlook_cancel_event_preview', { eventId: 'evt-1' });
    expect(result.structuredContent?.title).toBe('Remove event from calendar');
    expect(result.structuredContent?.confirmLabel).toBe('Remove');
  });
});

describe('outlook_cancel_event_confirm', () => {
  it('POSTs /cancel with the comment when Graph says the user organizes it', async () => {
    const result = await cancelTool('outlook_cancel_event_confirm', {
      eventId: 'evt-1',
      comment: 'Moving this to next week',
    });

    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST']);
    expect(requests[1].url).toContain('/me/events/evt-1/cancel');
    expect(requests[1].body).toEqual({ comment: 'Moving this to next week' });
    expect(result.content[0]?.text).toContain('attendees were notified');
  });

  it('DELETEs the event when Graph says the user is an attendee', async () => {
    isOrganizer = false;
    const result = await cancelTool('outlook_cancel_event_confirm', { eventId: 'evt-1' });

    expect(requests.map((request) => request.method)).toEqual(['GET', 'DELETE']);
    expect(requests[1].url).toContain('/me/events/evt-1');
    expect(requests[1].url).not.toContain('/cancel');
    expect(result.content[0]?.text).toContain('Removed');
  });
});
