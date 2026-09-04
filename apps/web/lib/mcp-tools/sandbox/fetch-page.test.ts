/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * sandbox_fetch_page against a scripted worker client: the URL goes to
 * the worker under the caller's target, the staged bytes are read back
 * and deleted whatever happens, HTML comes back as page text with its
 * title and links, plain text as itself, a worker refusal (a blocked
 * address, say) as a clean error, and a caller with no identity is
 * refused before any call.
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: jest.fn(() => ({ url: 'http://sandbox.internal:8092', key: 'k' })),
  sandboxBrowserEnabled: jest.fn(() => false),
  clientFailure: jest.fn((error: { kind: string; type?: string; message?: string }) => ({
    status: 400,
    message: error.message ?? `failed: ${error.type ?? error.kind}`,
  })),
  sbFetchUrl: jest.fn(),
  sbListFiles: jest.fn(),
  sbStatFile: jest.fn(),
  sbReadFile: jest.fn(),
  sbWriteFile: jest.fn(),
  sbDeleteFile: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerSandboxTools } from './index';
import type { MCPToolContext } from '../common';

const client = jest.requireMock<Record<string, jest.Mock>>('@/lib/sandbox/service-client');

type Handler = (
  args: Record<string, unknown>
) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface Registered {
  config: { annotations?: { readOnlyHint?: boolean } };
  handler: Handler;
}

function collect(context: MCPToolContext): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Handler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerSandboxTools(server, context);
  return tools;
}

const context = (subject = 'auth0|alice'): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject,
    origin: 'https://renkei.example',
  }) as unknown as MCPToolContext;

const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const STAGED = {
  id: '11111111-1111-4111-8111-111111111111',
  filename: 'status',
  contentType: 'text/html; charset=utf-8',
  sizeBytes: 100,
  source: 'fetch:example.com',
  batchId: null,
  createdAt: '2026-09-04T00:00:00Z',
  expiresAt: '2026-09-05T00:00:00Z',
};

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

beforeEach(() => {
  jest.clearAllMocks();
  client.sbDeleteFile.mockResolvedValue({ ok: true, val: { id: STAGED.id } });
});

describe('sandbox_fetch_page', () => {
  it('is a read tool', () => {
    const tools = collect(context());
    expect(tools.get('sandbox_fetch_page')?.config.annotations?.readOnlyHint).toBe(true);
  });

  it('fetches through the worker, answers the page text, and deletes the staged copy', async () => {
    client.sbFetchUrl.mockResolvedValue({ ok: true, val: STAGED });
    client.sbReadFile.mockResolvedValue({
      ok: true,
      val: {
        filename: 'status',
        contentType: 'text/html; charset=utf-8',
        bytes: bytesOf(
          '<html><head><title>Status</title></head><body><nav>Menu</nav><h1>All good</h1><p>See <a href="/history">history</a>.</p></body></html>'
        ),
      },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_fetch_page')!
      .handler({ url: 'https://example.com/status', maxChars: 500 });
    expect(client.sbFetchUrl).toHaveBeenCalledWith(TARGET, {
      url: 'https://example.com/status',
      filename: 'page.html',
    });
    expect(client.sbReadFile).toHaveBeenCalledWith(TARGET, STAGED.id);
    expect(client.sbDeleteFile).toHaveBeenCalledWith(TARGET, STAGED.id);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      'Page: Status\nURL: https://example.com/status\n---\n# All good\n\nSee history (https://example.com/history).'
    );
  });

  it('names the staged copy after the URL’s file when it has one', async () => {
    client.sbFetchUrl.mockResolvedValue({
      ok: true,
      val: { ...STAGED, contentType: 'text/plain' },
    });
    client.sbReadFile.mockResolvedValue({
      ok: true,
      val: { filename: 'notes.txt', contentType: 'text/plain', bytes: bytesOf('plain words\n') },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_fetch_page')!
      .handler({ url: 'https://example.com/docs/notes.txt' });
    expect(client.sbFetchUrl).toHaveBeenCalledWith(TARGET, {
      url: 'https://example.com/docs/notes.txt',
      filename: 'notes.txt',
    });
    expect(result.content[0].text).toBe(
      'URL: https://example.com/docs/notes.txt\nType: text/plain\n---\nplain words\n'
    );
  });

  it('reads HTML that arrived without a content type', async () => {
    client.sbFetchUrl.mockResolvedValue({ ok: true, val: { ...STAGED, contentType: null } });
    client.sbReadFile.mockResolvedValue({
      ok: true,
      val: {
        filename: 'page.html',
        contentType: null,
        bytes: bytesOf('<!doctype html><p>Hi there</p>'),
      },
    });
    const tools = collect(context());
    const result = await tools.get('sandbox_fetch_page')!.handler({ url: 'https://example.com/' });
    expect(result.content[0].text).toContain('---\nHi there');
  });

  it('refuses what the worker refuses, without reading', async () => {
    client.sbFetchUrl.mockResolvedValue({
      ok: false,
      err: {
        kind: 'refused',
        type: 'blocked_url',
        message: 'That address is not reachable from here.',
      },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_fetch_page')!
      .handler({ url: 'https://169.254.169.254/latest/meta-data' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('That address is not reachable from here.');
    expect(client.sbReadFile).not.toHaveBeenCalled();
    expect(client.sbDeleteFile).not.toHaveBeenCalled();
  });

  it('still deletes the staged copy when the read fails', async () => {
    client.sbFetchUrl.mockResolvedValue({ ok: true, val: STAGED });
    client.sbReadFile.mockResolvedValue({
      ok: false,
      err: { kind: 'unreachable', message: 'gone' },
    });
    const tools = collect(context());
    const result = await tools.get('sandbox_fetch_page')!.handler({ url: 'https://example.com/' });
    expect(result.isError).toBe(true);
    expect(client.sbDeleteFile).toHaveBeenCalledWith(TARGET, STAGED.id);
  });

  it('refuses a binary it cannot read as text, pointing at the download tool', async () => {
    client.sbFetchUrl.mockResolvedValue({ ok: true, val: { ...STAGED, contentType: 'image/png' } });
    client.sbReadFile.mockResolvedValue({
      ok: true,
      val: {
        filename: 'x.png',
        contentType: 'image/png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_fetch_page')!
      .handler({ url: 'https://example.com/x.png' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/readable as text; sandbox_download_url/);
  });

  it('refuses a caller with no identity before any call', async () => {
    const tools = collect(context(''));
    const result = await tools.get('sandbox_fetch_page')!.handler({ url: 'https://example.com/' });
    expect(result.isError).toBe(true);
    expect(client.sbFetchUrl).not.toHaveBeenCalled();
  });
});
