/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Guards for the Outlook attachment tools. The interesting behavior is
 * the branching: inline images hidden by default, textual formats decoded
 * to readable text, binary formats bounded rather than dumped into
 * context, and the two non-file attachment kinds (reference/item) handled
 * instead of silently returning nothing.
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
// oauthGraphAuth, not a stub: this file already mocks provider-grants/
// crypto/db/microsoft-app to serve a fake grant, so the real resolution
// path is exercised the same way the rest of this suite's fetch mocking is.
import { oauthGraphAuth } from '../graph/graph-auth';

type ToolResult = {
  content: { type: string; text?: string; mimeType?: string; data?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Response bodies keyed by a substring of the requested URL. */
let routes: { match: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  routes = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const target = String(url);
    // Batch requests carry their sub-request urls in the payload.
    if (target.endsWith('/$batch')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        requests: { id: string; url: string }[];
      };
      const body = {
        responses: payload.requests.map((request) => ({
          id: request.id,
          status: 200,
          body: routes.find((route) => request.url.includes(route.match))?.body ?? { value: [] },
        })),
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    }
    const body = routes.find((route) => target.includes(route.match))?.body ?? { value: [] };
    return {
      ok: true,
      status: 200,
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

const textOf = (result: ToolResult) => result.content[0]?.text ?? '';

describe('outlook_list_attachments', () => {
  it('hides inline images by default and says how many it hid', async () => {
    routes = [
      {
        match: '/attachments',
        body: {
          value: [
            { id: 'a1', name: 'report.pdf', contentType: 'application/pdf', size: 100 },
            { id: 'a2', name: 'logo.png', contentType: 'image/png', size: 20, isInline: true },
          ],
        },
      },
    ];
    const result = await tool('outlook_list_attachments', { messageId: 'm1' });
    expect(textOf(result)).toContain('report.pdf');
    expect(textOf(result)).not.toContain('logo.png');
  });

  it('includes inline images on request', async () => {
    routes = [
      {
        match: '/attachments',
        body: {
          value: [
            { id: 'a2', name: 'logo.png', contentType: 'image/png', size: 20, isInline: true },
          ],
        },
      },
    ];
    const result = await tool('outlook_list_attachments', {
      messageId: 'm1',
      includeInline: true,
    });
    expect(textOf(result)).toContain('logo.png');
    expect(textOf(result)).toContain('inline');
  });

  it('distinguishes "no attachments" from "only inline ones"', async () => {
    routes = [
      {
        match: '/attachments',
        body: {
          value: [
            { id: 'a2', name: 'logo.png', contentType: 'image/png', size: 20, isInline: true },
          ],
        },
      },
    ];
    const result = await tool('outlook_list_attachments', { messageId: 'm1' });
    expect(textOf(result)).toContain('1 inline image(s) hidden');
  });
});

describe('outlook_get_attachment', () => {
  it('decodes a textual attachment to readable text', async () => {
    routes = [
      {
        match: '/attachments/',
        body: {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'a1',
          name: 'data.csv',
          contentType: 'text/csv',
          size: 11,
          contentBytes: Buffer.from('name,total\na,1').toString('base64'),
        },
      },
    ];
    const result = await tool('outlook_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    expect(textOf(result)).toContain('name,total');
    expect(textOf(result)).toContain('data.csv');
  });

  it('text-extracts a Word attachment instead of returning base64', async () => {
    const { buildDocx, paragraph } = await import('@renkei/document-text/src/test-support');
    const docx = buildDocx(paragraph('The vendor agreement renews in March.'));
    routes = [
      {
        match: '/attachments/',
        body: {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'a1',
          name: 'contract.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: docx.byteLength,
          contentBytes: Buffer.from(docx).toString('base64'),
        },
      },
    ];
    const result = await tool('outlook_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    expect(textOf(result)).toContain('The vendor agreement renews in March.');
    expect(textOf(result)).not.toContain('base64');
    // Word is not page-renderable by the providers, so no document rides along.
    expect(result._meta).toBeUndefined();
  });

  it('attaches a PDF as a viewable document in _meta even when unextractable', async () => {
    routes = [
      {
        match: '/attachments/',
        body: {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'a1',
          name: 'scan.pdf',
          contentType: 'application/pdf',
          size: 4,
          contentBytes: 'AAAA',
        },
      },
    ];
    const result = await tool('outlook_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    // Extraction of garbage bytes fails, but the document itself still rides
    // for the agent engine to show the model — so this is NOT an error.
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('attached for direct viewing');
    const docs = result._meta?.renkeiDocuments;
    expect(Array.isArray(docs)).toBe(true);
    if (Array.isArray(docs)) {
      expect(docs[0]).toMatchObject({
        mediaType: 'application/pdf',
        dataBase64: 'AAAA',
        title: 'scan.pdf',
      });
    }
  });

  it('returns an image as MCP image content plus the _meta attachment', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    routes = [
      {
        match: '/attachments/',
        body: {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'a1',
          name: 'chart.png',
          contentType: 'image/png',
          size: 8,
          contentBytes: png,
        },
      },
    ];
    const result = await tool('outlook_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    const image = result.content.find((block) => block.type === 'image');
    expect(image).toMatchObject({ mimeType: 'image/png', data: png });
    expect(Array.isArray(result._meta?.renkeiDocuments)).toBe(true);
  });

  it('falls back to extraction alone for a PDF over the attach ceiling', async () => {
    // >10MB of actual bytes: too big to page-render, and too big to parse.
    const big = Buffer.alloc(11_000_000, 0x41).toString('base64');
    routes = [
      {
        match: '/attachments/',
        body: {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'a1',
          name: 'huge.pdf',
          contentType: 'application/pdf',
          size: 11_000_000,
          contentBytes: big,
        },
      },
    ];
    const result = await tool('outlook_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    expect(result._meta).toBeUndefined();
    expect(textOf(result)).not.toContain(big.slice(0, 100));
  });

  it('explains a reference attachment has no bytes to download', async () => {
    routes = [
      {
        match: '/attachments/',
        body: {
          '@odata.type': '#microsoft.graph.referenceAttachment',
          id: 'a1',
          name: 'Shared doc',
          contentType: 'application/octet-stream',
          size: 0,
          sourceUrl: 'https://contoso.sharepoint.com/doc',
        },
      },
    ];
    const result = await tool('outlook_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    expect(textOf(result)).toContain('link to a cloud file');
    expect(textOf(result)).toContain('https://contoso.sharepoint.com/doc');
  });

  it('renders an embedded item attachment instead of returning nothing', async () => {
    routes = [
      {
        match: '/attachments/',
        body: {
          '@odata.type': '#microsoft.graph.itemAttachment',
          id: 'a1',
          name: 'FW: budget',
          contentType: 'message/rfc822',
          size: 500,
          item: {
            subject: 'budget numbers',
            from: { emailAddress: { address: 'dana@example.com' } },
            body: { content: 'here they are' },
          },
        },
      },
    ];
    const result = await tool('outlook_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    expect(textOf(result)).toContain('embedded item');
    expect(textOf(result)).toContain('budget numbers');
    expect(textOf(result)).toContain('dana@example.com');
  });
});

describe('outlook_bulk_list_attachments', () => {
  it('surveys many messages in one batched call and skips empty ones', async () => {
    routes = [
      {
        match: '/attachments',
        body: {
          value: [{ id: 'a1', name: 'report.pdf', contentType: 'application/pdf', size: 100 }],
        },
      },
    ];
    const result = await tool('outlook_bulk_list_attachments', { messageIds: ['m1', 'm2'] });
    const text = textOf(result);
    expect(text).toContain('message m1');
    expect(text).toContain('report.pdf');
    expect(text).toContain('2 attachment(s) across 2 of 2 message(s)');
  });
});
