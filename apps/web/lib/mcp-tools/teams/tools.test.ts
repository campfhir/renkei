/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The Teams tool surface, against a stubbed Graph. Same harness as
 * sharepoint/tools.test.ts: the delegate client is mocked so the grant's
 * fetcher sends through global fetch, which each test answers.
 */

jest.mock('@renkei/provider-grants', () => ({ MICROSOFT: 'microsoft' }));
jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({
      describe: jest.fn(async () => ({
        ok: true,
        val: { accountId: 'acct-1', metadata: { upn: 'alice@example.com' } },
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
jest.mock('@renkei/db', () => ({ getDataStore: () => ({}) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerTeamsTools } from './index';
import { oauthGraphAuth } from '../graph/graph-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

interface Route {
  match: string;
  method?: string;
  body?: unknown;
  status?: number;
}

let routes: Route[] = [];
let requests: { url: string; method: string; body: string | null }[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  requests = [];
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : null });
    const route = routes.find(
      (candidate) => url.includes(candidate.match) && (candidate.method ?? 'GET') === method
    );
    if (!route) {
      return new Response(JSON.stringify({ error: `no stub for ${method} ${url}` }), {
        status: 404,
      });
    }
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const context = (): MCPToolContext =>
  ({
    accountId: 'acct-1',
    subject: 'subject-1',
    origin: 'https://renkei.example',
    siteUrl: '',
    apiBaseUrl: '',
    maxJqlResults: 100,
  }) as unknown as MCPToolContext;

async function tools(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const ctx = context();
  await registerTeamsTools(server, ctx, oauthGraphAuth(ctx));
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

const MESSAGE = (id: string, who: string, html: string, type = 'message') => ({
  id,
  messageType: type,
  createdDateTime: '2026-10-29T09:15:00Z',
  from: { user: { displayName: who } },
  body: { contentType: 'html', content: html },
});

describe('teams chats', () => {
  it('names a chat by its topic, else by the OTHER people in it', async () => {
    routes = [
      {
        match: '/me/chats?',
        body: {
          value: [
            {
              id: 'chat-group',
              chatType: 'group',
              topic: 'Q4 planning',
              members: [{ displayName: 'Alice', email: 'alice@example.com' }],
              lastMessagePreview: {
                createdDateTime: '2026-10-29T09:00:00Z',
                from: { user: { displayName: 'Bob' } },
                body: { contentType: 'html', content: '<p>Numbers are <b>in</b></p>' },
              },
            },
            {
              id: 'chat-11',
              chatType: 'oneOnOne',
              members: [
                { displayName: 'Alice', email: 'alice@example.com' },
                { displayName: 'Bob Builder', email: 'bob@example.com' },
              ],
            },
          ],
        },
      },
    ];

    const result = await (await tools()).get('teams_list_chats')!({});

    const text = textOf(result);
    expect(text).toContain('💬 Q4 planning (group)');
    expect(text).toContain('last: Bob: Numbers are in');
    // The caller is not listed as the other party of their own 1:1.
    expect(text).toContain('💬 Bob Builder (oneOnOne)');
    expect(text).not.toContain('Alice, Bob Builder');
    expect(text).toContain('chatId: chat-11');
    expect(requests[0]!.url).toContain('$expand=members,lastMessagePreview');
  });

  it('keeps only the chats matching `with`', async () => {
    routes = [
      {
        match: '/me/chats?',
        body: {
          value: [
            { id: 'a', chatType: 'group', topic: 'Budget', members: [] },
            {
              id: 'b',
              chatType: 'oneOnOne',
              members: [{ displayName: 'Carol', email: 'carol@example.com' }],
            },
          ],
        },
      },
    ];

    const result = await (await tools()).get('teams_list_chats')!({ with: 'carol@' });

    expect(textOf(result)).toContain('chatId: b');
    expect(textOf(result)).not.toContain('chatId: a');
  });

  it('reads a chat as text, leaving system events out', async () => {
    routes = [
      {
        match: '/chats/chat-1/messages',
        body: {
          value: [
            MESSAGE(
              'm2',
              'Bob',
              '<div>Hi <at id="0">Alice</at>, see <a href="x">the doc</a></div>'
            ),
            MESSAGE('m1', 'System', '', 'systemEventMessage'),
          ],
        },
      },
    ];

    const result = await (await tools()).get('teams_list_chat_messages')!({ chatId: 'chat-1' });

    const text = textOf(result);
    expect(text).toContain('1 message(s)');
    expect(text).toContain('Bob — 2026-10-29 09:15');
    expect(text).toContain('Hi Alice, see the doc');
    expect(text).toContain('messageId: m2');
    expect(text).not.toContain('m1');
  });

  it('sends a chat message as HTML rendered from Markdown', async () => {
    routes = [{ match: '/chats/chat-1/messages', method: 'POST', body: { id: 'sent-1' } }];

    const result = await (await tools()).get('teams_send_chat_message')!({
      chatId: 'chat-1',
      markdown: 'Shipping **Friday**',
    });

    expect(textOf(result)).toContain('Sent (message id sent-1');
    const sent = JSON.parse(requests[0]!.body ?? '{}');
    expect(sent.body.contentType).toBe('html');
    expect(sent.body.content).toContain('<strong>Friday</strong>');
  });

  it('finds the existing 1:1 chat for an address before starting a new one', async () => {
    routes = [
      { match: '/me?', body: { id: 'me-id', userPrincipalName: 'alice@example.com' } },
      {
        match: "/me/chats?$filter=chatType eq 'oneOnOne'",
        body: {
          value: [
            {
              id: 'chat-bob',
              members: [{ email: 'alice@example.com' }, { email: 'Bob@example.com' }],
            },
          ],
        },
      },
      { match: '/chats/chat-bob/messages', method: 'POST', body: { id: 'sent-2' } },
    ];

    const result = await (await tools()).get('teams_send_chat_message')!({
      toEmail: 'bob@example.com',
      markdown: 'hi',
    });

    expect(textOf(result)).toContain('chat chat-bob)');
    expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/chats'))).toBe(false);
  });

  it('starts a 1:1 chat when none exists, binding both members', async () => {
    routes = [
      { match: '/me?', body: { id: 'me-id', userPrincipalName: 'alice@example.com' } },
      { match: "/me/chats?$filter=chatType eq 'oneOnOne'", body: { value: [] } },
      { match: '/chats', method: 'POST', body: { id: 'chat-new' } },
      { match: '/chats/chat-new/messages', method: 'POST', body: { id: 'sent-3' } },
    ];

    const result = await (await tools()).get('teams_send_chat_message')!({
      toEmail: 'dan@example.com',
      markdown: 'hi',
    });

    expect(textOf(result)).toContain('new chat');
    const create = requests.find((r) => r.method === 'POST' && r.url.endsWith('/chats'))!;
    const payload = JSON.parse(create.body ?? '{}');
    expect(payload.chatType).toBe('oneOnOne');
    expect(payload.members.map((m: { 'user@odata.bind': string }) => m['user@odata.bind'])).toEqual(
      [
        "https://graph.microsoft.com/v1.0/users('me-id')",
        "https://graph.microsoft.com/v1.0/users('dan@example.com')",
      ]
    );
  });

  it('refuses a message to the caller’s own address', async () => {
    routes = [{ match: '/me?', body: { id: 'me-id', userPrincipalName: 'alice@example.com' } }];

    const result = await (await tools()).get('teams_send_chat_message')!({
      toEmail: 'Alice@example.com',
      markdown: 'note',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('your own account');
  });

  it('insists on exactly one destination', async () => {
    const send = (await tools()).get('teams_send_chat_message')!;
    expect(textOf(await send({ markdown: 'x' }))).toContain('Provide chatId or toEmail');
    expect(textOf(await send({ chatId: 'a', toEmail: 'b@x', markdown: 'x' }))).toContain(
      'not both'
    );
  });
});

describe('teams channels', () => {
  it('posts a new post with its subject, and a reply under a post', async () => {
    // Most specific first: the stub takes the first match, and a reply's
    // URL contains the post URL.
    routes = [
      { match: '/messages/p-1/replies', method: 'POST', body: { id: 'r-1' } },
      {
        match: '/channels/ch-1/messages',
        method: 'POST',
        body: { id: 'p-1', webUrl: 'https://t/p1' },
      },
    ];
    const post = (await tools()).get('teams_send_channel_message')!;

    const posted = await post({
      teamId: 'team-1',
      channelId: 'ch-1',
      subject: 'Release notes',
      markdown: 'Out now',
    });
    expect(textOf(posted)).toContain('Posted (message id p-1)');
    expect(textOf(posted)).toContain('https://t/p1');
    expect(JSON.parse(requests[0]!.body ?? '{}').subject).toBe('Release notes');

    const replied = await post({
      teamId: 'team-1',
      channelId: 'ch-1',
      replyToId: 'p-1',
      subject: 'ignored on a reply',
      markdown: 'Thanks',
    });
    expect(textOf(replied)).toContain('Replied (message id r-1)');
    expect(requests[1]!.url).toContain('/messages/p-1/replies');
    expect(JSON.parse(requests[1]!.body ?? '{}').subject).toBeUndefined();
  });

  it('lists channel posts with their subject lines', async () => {
    routes = [
      {
        match: '/channels/ch-1/messages?',
        body: { value: [{ ...MESSAGE('p-1', 'Erin', '<p>Done</p>'), subject: 'Standup' }] },
      },
    ];

    const result = await (await tools()).get('teams_list_channel_messages')!({
      teamId: 'team-1',
      channelId: 'ch-1',
    });

    expect(textOf(result)).toContain('**Standup**');
    expect(textOf(result)).toContain('Erin — ');
  });
});

describe('teams presence', () => {
  it('resolves addresses to ids and reports each person once', async () => {
    routes = [
      { match: '/users/bob%40example.com?', body: { id: 'bob-id', displayName: 'Bob' } },
      { match: '/users/nobody%40example.com?', status: 404 },
      {
        match: '/communications/getPresencesByUserId',
        method: 'POST',
        body: {
          value: [
            {
              id: 'bob-id',
              availability: 'Busy',
              activity: 'InACall',
              statusMessage: { message: { content: 'Back at 3' } },
            },
          ],
        },
      },
    ];

    const result = await (await tools()).get('teams_get_presence')!({
      emails: ['bob@example.com', 'nobody@example.com'],
    });

    const text = textOf(result);
    expect(text).toContain('• Bob: Busy (InACall) — “Back at 3”');
    expect(text).toContain('Not found in the directory: nobody@example.com');
  });

  it('answers the caller’s own presence when no one is named', async () => {
    routes = [
      { match: '/me/presence', body: { availability: 'Available', activity: 'Available' } },
    ];

    const result = await (await tools()).get('teams_get_presence')!({});

    expect(textOf(result)).toBe('• You: Available');
  });
});

describe('teams search', () => {
  it('flattens search hits and says where each was said', async () => {
    routes = [
      {
        match: '/search/query',
        method: 'POST',
        body: {
          value: [
            {
              hitsContainers: [
                {
                  hits: [
                    {
                      summary: 'the <c0>budget</c0> is final',
                      resource: {
                        id: 'm-9',
                        createdDateTime: '2026-10-28T16:00:00Z',
                        from: { user: { displayName: 'Faye' } },
                        channelIdentity: { teamId: 't-1', channelId: 'c-1' },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ];

    const result = await (await tools()).get('teams_search_messages')!({ query: 'budget' });

    const text = textOf(result);
    expect(text).toContain('Faye — 2026-10-28 16:00');
    expect(text).toContain('the budget is final');
    expect(text).toContain('teamId: t-1  channelId: c-1  messageId: m-9');
    expect(JSON.parse(requests[0]!.body ?? '{}').requests[0].entityTypes).toEqual(['chatMessage']);
  });
});
