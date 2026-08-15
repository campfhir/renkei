/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for jira_add_attachment.
 *
 * The upload used to go through bare fetch — no 401 refresh, no structured
 * error — and MAX_ATTACHMENT_BYTES was configured but never enforced.
 */

jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// getCachedDisplayName is the only runtime import attachments.ts still has from
// ../common (auth moved to the injected JiraAuth — see jira-auth.ts) — but
// merely importing ../common transitively pulls in @renkei/db, whose kysely
// import is ESM-only and untransformed here.
jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Tester',
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerAttachmentTools } from './attachments';
import type { JiraAuth } from './jira-auth';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

const jiraFetchMock = jest.fn();

/** A stub JiraAuth routing every call to jiraFetchMock with just the relative path. */
function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: (_requiredScopes, path, init) => jiraFetchMock(path, init),
  };
}

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
    maxAttachmentBytes: maxBytes,
  };

  await registerAttachmentTools(server, context, stubAuth());
  const handler = handlers.get('jira_add_attachment');
  if (!handler) throw new Error('jira_add_attachment was not registered');
  return handler;
}

beforeEach(() => {
  jiraFetchMock.mockReset();
});

describe('jira_add_attachment', () => {
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

  it('uploads through auth.fetch with a FormData body', async () => {
    jiraFetchMock.mockResolvedValue(new Response('[]', { status: 200 }));

    const handler = await addAttachmentHandler(1024);
    const result = await handler({
      issueKey: 'PROJ-1',
      filename: 'note.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
    });

    expect(result.isError).toBeUndefined();
    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = jiraFetchMock.mock.calls[0] as [
      string,
      { method: string; body: unknown },
    ];
    expect(path).toBe('/rest/api/3/issue/PROJ-1/attachments');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('surfaces auth.fetch failures as tool errors', async () => {
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
