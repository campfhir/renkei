/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for the Jira attachment tools.
 *
 * jira_add_attachment deliberately has NO base64 content parameter — a tool
 * argument is text the calling model must generate, and megabytes of base64
 * read as the tool "hanging". Bytes come from a Microsoft 365 source fetched
 * server-side, or out-of-band via jira_request_attachment_upload.
 */

jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// getCachedDisplayName is the only runtime import attachments.ts still has from
// ../common — but merely importing ../common transitively pulls in @renkei/db,
// whose kysely import is ESM-only and untransformed here.
jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Tester',
}));
// graph/client and upload-slots both sit on @renkei/db too; str/rec are pure
// and reproduced verbatim so argument plumbing behaves as in production.
jest.mock('../graph/client', () => ({
  graphGet: jest.fn(),
  resolveGraphAccess: jest.fn(),
  str: (value: unknown) => (typeof value === 'string' ? value : ''),
  rec: (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {},
}));
jest.mock('@renkei/connector-microsoft', () => ({ graphDownload: jest.fn() }));
jest.mock('../upload-slots', () => ({ createUploadSlot: jest.fn() }));

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerAttachmentTools } from './attachments';
import type { JiraAuth } from './jira-auth';

const { graphGet, resolveGraphAccess } = jest.requireMock<{
  graphGet: jest.Mock;
  resolveGraphAccess: jest.Mock;
}>('../graph/client');
const { graphDownload } = jest.requireMock<{ graphDownload: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const { createUploadSlot } = jest.requireMock<{ createUploadSlot: jest.Mock }>('../upload-slots');

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

async function attachmentHandlers(maxBytes?: number): Promise<Map<string, ToolHandler>> {
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
  return handlers;
}

async function addAttachmentHandler(maxBytes?: number): Promise<ToolHandler> {
  const handler = (await attachmentHandlers(maxBytes)).get('jira_add_attachment');
  if (!handler) throw new Error('jira_add_attachment was not registered');
  return handler;
}

beforeEach(() => {
  jiraFetchMock.mockReset();
  graphGet.mockReset();
  resolveGraphAccess.mockReset();
  graphDownload.mockReset();
  createUploadSlot.mockReset();
  resolveGraphAccess.mockResolvedValue({ accessToken: 'graph-token' });
});

describe('jira_add_attachment', () => {
  it('demands exactly one source — neither given', async () => {
    const handler = await addAttachmentHandler();
    const result = await handler({ issueKey: 'PROJ-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('exactly one source');
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  it('demands exactly one source — both given', async () => {
    const handler = await addAttachmentHandler();
    const result = await handler({
      issueKey: 'PROJ-1',
      driveItem: { driveId: 'd1', itemId: 'i1' },
      outlookAttachment: { messageId: 'm1', attachmentId: 'a1' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('exactly one source');
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  it('fails cleanly when Microsoft 365 is not connected', async () => {
    resolveGraphAccess.mockResolvedValue('Microsoft 365 is not connected.');

    const handler = await addAttachmentHandler();
    const result = await handler({
      issueKey: 'PROJ-1',
      driveItem: { driveId: 'd1', itemId: 'i1' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Connect Microsoft 365');
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  it('forwards a OneDrive/SharePoint item to Jira as multipart FormData', async () => {
    graphDownload.mockResolvedValue({
      ok: true,
      val: { bytes: new Uint8Array([1, 2, 3]), item: { name: 'report.pdf' } },
    });
    jiraFetchMock.mockResolvedValue(new Response('[]', { status: 200 }));

    const handler = await addAttachmentHandler();
    const result = await handler({
      issueKey: 'PROJ-1',
      driveItem: { driveId: 'd1', itemId: 'i1' },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Attached report.pdf to PROJ-1');
    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = jiraFetchMock.mock.calls[0] as [
      string,
      { method: string; body: unknown },
    ];
    expect(path).toBe('/rest/api/3/issue/PROJ-1/attachments');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('copies an Outlook attachment onto the issue', async () => {
    graphGet.mockResolvedValue({
      ok: true,
      body: { name: 'invoice.pdf', contentBytes: Buffer.from('hello').toString('base64') },
    });
    jiraFetchMock.mockResolvedValue(new Response('[]', { status: 200 }));

    const handler = await addAttachmentHandler();
    const result = await handler({
      issueKey: 'PROJ-1',
      outlookAttachment: { messageId: 'm1', attachmentId: 'a1' },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Attached invoice.pdf to PROJ-1');
    expect(graphGet.mock.calls[0][2]).toBe('/me/messages/m1/attachments/a1');
  });

  it('refuses a non-file Outlook attachment instead of attaching junk', async () => {
    graphGet.mockResolvedValue({ ok: true, body: { name: 'meeting.ics' } });

    const handler = await addAttachmentHandler();
    const result = await handler({
      issueKey: 'PROJ-1',
      outlookAttachment: { messageId: 'm1', attachmentId: 'a1' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no file content');
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  it('refuses a source over MAX_ATTACHMENT_BYTES without calling Jira', async () => {
    graphGet.mockResolvedValue({
      ok: true,
      body: {
        name: 'big.bin',
        contentBytes: Buffer.from('this payload is longer than sixteen bytes').toString('base64'),
      },
    });

    const handler = await addAttachmentHandler(16);
    const result = await handler({
      issueKey: 'PROJ-1',
      outlookAttachment: { messageId: 'm1', attachmentId: 'a1' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('MAX_ATTACHMENT_BYTES');
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  it('surfaces auth.fetch failures as tool errors', async () => {
    graphDownload.mockResolvedValue({
      ok: true,
      val: { bytes: new Uint8Array([1]), item: { name: 'note.txt' } },
    });
    jiraFetchMock.mockRejectedValue(new Error('Jira API 403: attachments are disabled'));

    const handler = await addAttachmentHandler();
    const result = await handler({
      issueKey: 'PROJ-1',
      driveItem: { driveId: 'd1', itemId: 'i1' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Jira API 403');
  });
});

describe('jira_request_attachment_upload', () => {
  it('mints a slot and returns its instructions verbatim', async () => {
    createUploadSlot.mockResolvedValue({
      ok: true,
      uploadId: 'upload-1',
      instructions: 'INSTRUCTIONS',
    });

    const handler = (await attachmentHandlers()).get('jira_request_attachment_upload');
    if (!handler) throw new Error('jira_request_attachment_upload was not registered');
    const result = await handler({ issueKey: 'PROJ-1', filename: 'report.pdf' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('INSTRUCTIONS');
    const [, kind, destination] = createUploadSlot.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(kind).toBe('jira-attachment');
    expect(destination).toEqual({ issueKey: 'PROJ-1' });
  });

  it('requires issueKey and filename before minting anything', async () => {
    const handler = (await attachmentHandlers()).get('jira_request_attachment_upload');
    if (!handler) throw new Error('jira_request_attachment_upload was not registered');
    const result = await handler({ issueKey: 'PROJ-1' });

    expect(result.isError).toBe(true);
    expect(createUploadSlot).not.toHaveBeenCalled();
  });
});
