/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for add_attachment.
 *
 * The upload used to go through bare fetch — no 401 refresh, no structured
 * error — and MAX_ATTACHMENT_BYTES was configured but never enforced.
 */

jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// requireActual('../common') below loads the real module, whose import chain
// (tenant-operations → db) cannot load in a unit test environment.
jest.mock('@/lib/tenant-operations', () => ({
  refreshAtlassianTokenDirect: jest.fn(),
}));

const jiraFetchMock = jest.fn();
jest.mock('../common', () => {
  const actual = jest.requireActual<typeof import('../common')>('../common');
  return {
    ...actual,
    jiraFetch: (...args: unknown[]) => jiraFetchMock(...args),
  };
});

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { Env } from '@/lib/env';
import { registerAttachmentTools } from './attachments';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

async function addAttachmentHandler(maxBytes?: number): Promise<ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  const context: MCPToolContext = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    siteUrl: 'https://example.atlassian.net',
    apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    accessToken: 'token',
    maxJqlResults: 100,
    config:
      maxBytes === undefined ? undefined : ({ MAX_ATTACHMENT_BYTES: maxBytes } as unknown as Env),
  };

  await registerAttachmentTools(server, context);
  const handler = handlers.get('add_attachment');
  if (!handler) throw new Error('add_attachment was not registered');
  return handler;
}

beforeEach(() => {
  jiraFetchMock.mockReset();
});

describe('add_attachment', () => {
  it('refuses a file over MAX_ATTACHMENT_BYTES without calling Jira', async () => {
    const handler = await addAttachmentHandler(16);
    const result = await handler({
      issueKey: 'PROJ-1',
      filename: 'big.bin',
      contentBase64: Buffer.from('this payload is longer than sixteen bytes').toString('base64'),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('MAX_ATTACHMENT_BYTES');
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  it('uploads through jiraFetch with a FormData body', async () => {
    jiraFetchMock.mockResolvedValue(new Response('[]', { status: 200 }));

    const handler = await addAttachmentHandler(1024);
    const result = await handler({
      issueKey: 'PROJ-1',
      filename: 'note.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
    });

    expect(result.isError).toBeUndefined();
    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
    const [url, token, options] = jiraFetchMock.mock.calls[0] as [
      string,
      string,
      { method: string; body: unknown },
    ];
    expect(url).toBe('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/PROJ-1/attachments');
    expect(token).toBe('token');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('surfaces jiraFetch failures as tool errors', async () => {
    jiraFetchMock.mockRejectedValue(new Error('Jira API 403: attachments are disabled'));

    const handler = await addAttachmentHandler(1024);
    const result = await handler({
      issueKey: 'PROJ-1',
      filename: 'note.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Jira API 403');
  });
});
