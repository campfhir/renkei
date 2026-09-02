/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Line breaks in a reply survive all the way to the draft and the card.
 *
 * Graph's `createReply` comment lands in an HTML body verbatim, where "\n"
 * is just whitespace — so a reply written as paragraphs and a numbered list
 * went out as one run-on line, and the preview card (fed by Graph's flat,
 * 255-char bodyPreview) showed the same. The draft is now created with no
 * comment and the text PATCHed on top in the draft's own content type, and
 * the card shows the caller's text as given.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { commentToHtml, prependComment } from './comment-body';

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

const COMMENT = 'Hi Sravya,\n\nTwo points to reconcile:\n1. Zero data retention\n2. Audit logging';
const QUOTED_HTML =
  '<html><head><meta charset="utf-8"></head><body><div id="divRplyFwdMsg">From: Sravya</div>' +
  '<div>original text</div></body></html>';

/** Every Graph request the tools made, in order. */
let requests: { method: string; url: string; body: unknown }[] = [];
/** The body Graph reports on the draft it just created. */
let draftBody: { contentType: string; content: string } = {
  contentType: 'html',
  content: QUOTED_HTML,
};

beforeEach(() => {
  requests = [];
  draftBody = { contentType: 'html', content: QUOTED_HTML };
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body =
      method === 'POST' && /\/(createReply|createReplyAll|createForward)$/.test(String(url))
        ? {
            id: 'draft-1',
            subject: 'RE: Sign-off',
            body: draftBody,
            bodyPreview: 'From: Sravya original text',
            toRecipients: [{ emailAddress: { address: 'sravya@example.com' } }],
            webLink: 'https://outlook.example/draft-1',
          }
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

describe('commentToHtml', () => {
  it('turns each newline into a <br> and escapes markup', () => {
    expect(commentToHtml('a\nb\r\nc & <d>')).toBe('<div>a<br>b<br>c &amp; &lt;d&gt;</div><br>');
  });
});

describe('prependComment', () => {
  it('inserts the HTML comment inside <body>, ahead of the quoted thread', () => {
    const result = prependComment({ contentType: 'html', content: QUOTED_HTML }, 'Hi,\n\nThanks');
    expect(result.contentType).toBe('HTML');
    expect(result.content).toBe(
      '<html><head><meta charset="utf-8"></head><body>' +
        '<div>Hi,<br><br>Thanks</div><br>' +
        '<div id="divRplyFwdMsg">From: Sravya</div><div>original text</div></body></html>'
    );
  });

  it('prepends when the HTML has no <body> tag', () => {
    const result = prependComment({ contentType: 'HTML', content: '<p>quoted</p>' }, 'Hi');
    expect(result.content).toBe('<div>Hi</div><br><p>quoted</p>');
  });

  it('keeps a plain-text draft plain, with the comment on top', () => {
    const result = prependComment({ contentType: 'text', content: 'quoted' }, 'Hi,\n\nThanks');
    expect(result).toEqual({ contentType: 'Text', content: 'Hi,\n\nThanks\n\nquoted' });
  });

  it('treats a missing body as HTML with nothing quoted', () => {
    expect(prependComment({}, 'Hi')).toEqual({ contentType: 'HTML', content: '<div>Hi</div><br>' });
  });
});

describe('outlook_reply_preview', () => {
  it('creates the draft without a comment and PATCHes the text on with <br> breaks', async () => {
    const result = await outlookTool('outlook_reply_preview', {
      messageId: 'msg-1',
      comment: COMMENT,
    });

    expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH']);
    expect(requests[0].url).toContain('/me/messages/msg-1/createReply');
    expect(requests[0].body).toEqual({});
    expect(requests[1].url).toContain('/me/messages/draft-1');
    expect(requests[1].body).toEqual({
      body: {
        contentType: 'HTML',
        content: QUOTED_HTML.replace(
          '<body>',
          '<body><div>Hi Sravya,<br><br>Two points to reconcile:<br>1. Zero data retention' +
            '<br>2. Audit logging</div><br>'
        ),
      },
    });
    // Recipients Graph auto-populated are left alone when nothing was added.
    expect(requests[1].body).not.toHaveProperty('toRecipients');
    expect(result.isError).toBeFalsy();
  });

  it('shows the card the caller’s text as written, not Graph’s flattened preview', async () => {
    const result = await outlookTool('outlook_reply_preview', {
      messageId: 'msg-1',
      comment: COMMENT,
    });
    expect(result.structuredContent?.body).toBe(COMMENT);
    expect(result.structuredContent?.kind).toBe('reply');
    expect(result.structuredContent?.to).toEqual(['sravya@example.com']);
  });

  it('keeps a plain-text thread plain', async () => {
    draftBody = { contentType: 'text', content: 'From: Sravya\noriginal text' };
    await outlookTool('outlook_reply_preview', { messageId: 'msg-1', comment: 'Hi,\n\nThanks' });
    expect(requests[1].body).toEqual({
      body: { contentType: 'Text', content: 'Hi,\n\nThanks\n\nFrom: Sravya\noriginal text' },
    });
  });

  it('rides the comment on the same PATCH as added recipients', async () => {
    await outlookTool('outlook_reply_preview', {
      messageId: 'msg-1',
      comment: 'Hi',
      cc: ['boss@example.com'],
    });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH']);
    expect(requests[1].body).toMatchObject({
      body: { contentType: 'HTML' },
      toRecipients: [{ emailAddress: { address: 'sravya@example.com' } }],
      ccRecipients: [{ emailAddress: { address: 'boss@example.com' } }],
    });
  });
});

describe('outlook_forward_preview', () => {
  it('PATCHes recipients only when there is no note', async () => {
    const result = await outlookTool('outlook_forward_preview', {
      messageId: 'msg-1',
      to: ['pat@example.com'],
    });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH']);
    expect(requests[0].url).toContain('/createForward');
    expect(requests[1].body).not.toHaveProperty('body');
    expect(result.structuredContent?.body).toBe('');
  });
});

describe('outlook_reply_message', () => {
  it('sends the same line-preserving body as the preview', async () => {
    await outlookTool('outlook_reply_message', { messageId: 'msg-1', comment: 'Hi,\nThere' });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH', 'POST']);
    expect(requests[1].body).toEqual({
      body: {
        contentType: 'HTML',
        content: QUOTED_HTML.replace('<body>', '<body><div>Hi,<br>There</div><br>'),
      },
    });
    expect(requests[2].url).toContain('/me/messages/draft-1/send');
  });
});
