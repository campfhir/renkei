/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Scheduled send for Outlook.
 *
 * Graph can hold a message until a time (PidTagDeferredSendTime, an extended
 * property on the message), so `sendAt` rides on outlook_send_mail and on the
 * send-draft confirm and on the direct reply, reply-all and forward tools.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

jest.mock('@renkei/provider-grants', () => ({ MICROSOFT: 'microsoft' }));
// The delegate, standing in: `describe` answers the one grant these suites
// need, and the fetcher it hands out sends through global fetch (the Graph
// stub each test installs) — with no Authorization of its own, since the
// real delegate attaches that on its side of the wire.
jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({
      describe: jest.fn(async () => ({
        ok: true,
        val: { accountId: 'acct-1', metadata: { upn: 'scott@example.com' } },
      })),
    }),
    grantFetch: jest.fn((ref: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch(
        jest.fn((url: string, init?: RequestInit) => fetch(url, init)),
        actual.grantKeyOf(ref)
      )
    ),
  };
});
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@renkei/connector-microsoft', () => ({
  ...jest.requireActual('@renkei/connector-microsoft/src/fetch'),
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  BATCH_CHUNK_SIZE: 20,
  graphBatch: jest.requireActual('@renkei/connector-microsoft/src/mail-batch').graphBatch,
  summarizeBatch: jest.requireActual('@renkei/connector-microsoft/src/mail-batch').summarizeBatch,
  withCategoryChanges: jest.requireActual('@renkei/connector-microsoft/src/mail-batch')
    .withCategoryChanges,
  buildMailQueryPath: jest.requireActual('@renkei/connector-microsoft/src/mail-filter')
    .buildMailQueryPath,
}));
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
    const body =
      method === 'POST' &&
      /\/me\/messages(\/[^/]+\/create(Reply|ReplyAll|Forward))?$/.test(String(url))
        ? { id: 'draft-1', toRecipients: [{ emailAddress: { address: 'orig@example.com' } }] }
        : {};
    return {
      ok: true,
      status: method === 'POST' ? 201 : 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
});

async function outlookTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      registered.set(toolName, handler);
    },
  } as unknown as McpServer;
  const context = { accountId: 'acct-1', subject: 'subject-1' } as MCPToolContext;
  await registerOutlookTools(server, context, oauthGraphAuth(context));
  const handler = registered.get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler(args);
}

const textOf = (result: ToolResult) => result.content[0]?.text ?? '';
const inHours = (hours: number, offset = '+00:00') => {
  const at = new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d+Z$/, '');
  return `${at}${offset}`;
};
const DEFERRED = 'SystemTime 0x3FEF';

describe('outlook_send_mail with sendAt', () => {
  const mail = { to: ['a@example.com'], subject: 'Hi', body: 'Hello' };

  it('sets the deferred-send property, as a UTC instant', async () => {
    const result = await outlookTool('outlook_send_mail', {
      ...mail,
      sendAt: inHours(2, '-05:00'),
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Scheduled for');
    const sent = requests.find((request) => request.url.endsWith('/me/sendMail'));
    const props = (
      sent?.body as { message: { singleValueExtendedProperties: { id: string; value: string }[] } }
    ).message.singleValueExtendedProperties;
    expect(props).toHaveLength(1);
    expect(props[0].id).toBe(DEFERRED);
    expect(props[0].value).toMatch(/Z$/);
  });

  it('sends at once, with no property, when sendAt is left out', async () => {
    await outlookTool('outlook_send_mail', mail);
    const sent = requests.find((request) => request.url.endsWith('/me/sendMail'));
    expect(JSON.stringify(sent?.body)).not.toContain(DEFERRED);
  });

  it('refuses a time with no offset, or one in the past, without calling Graph', async () => {
    const naive = await outlookTool('outlook_send_mail', {
      ...mail,
      sendAt: '2099-01-01T09:00:00',
    });
    expect(naive.isError).toBe(true);
    expect(textOf(naive)).toContain('UTC offset');
    const past = await outlookTool('outlook_send_mail', { ...mail, sendAt: inHours(-1) });
    expect(past.isError).toBe(true);
    expect(textOf(past)).toContain('future');
    expect(requests).toEqual([]);
  });
});

describe('outlook_send_draft_confirm with sendAt', () => {
  it('PATCHes the deferred time onto the draft, then sends it', async () => {
    const result = await outlookTool('outlook_send_draft_confirm', {
      draftId: 'draft-1',
      sendAt: inHours(3),
    });
    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => `${request.method} ${request.url.split('/v1.0')[1]}`)).toEqual(
      ['PATCH /me/messages/draft-1', 'POST /me/messages/draft-1/send']
    );
    expect(JSON.stringify(requests[0].body)).toContain(DEFERRED);
  });
});

describe('sendAt on reply, reply-all and forward', () => {
  it.each([
    ['outlook_reply_message', 'createReply', { comment: 'Thanks' }],
    ['outlook_reply_all_message', 'createReplyAll', { comment: 'Thanks' }],
    ['outlook_forward_message', 'createForward', { to: ['c@example.com'] }],
  ])('%s PATCHes the deferred time onto the draft before sending', async (tool, action, extra) => {
    const result = await outlookTool(tool, { messageId: 'msg-1', ...extra, sendAt: inHours(2) });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('scheduled for');
    const steps = requests.map((request) => `${request.method} ${request.url.split('/v1.0')[1]}`);
    expect(steps[0]).toBe(`POST /me/messages/msg-1/${action}`);
    expect(steps.at(-2)).toMatch(/^PATCH \/me\/messages\//);
    expect(steps.at(-1)).toMatch(/^POST \/me\/messages\/[^/]+\/send$/);
    expect(JSON.stringify(requests.at(-2)?.body)).toContain(DEFERRED);
  });

  it('refuses a past time before creating any draft', async () => {
    const result = await outlookTool('outlook_reply_message', {
      messageId: 'msg-1',
      comment: 'Thanks',
      sendAt: inHours(-1),
    });
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});
