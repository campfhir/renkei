/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * sandbox_render_document against a scripted worker client: a text format
 * is staged exactly as written, a document format is rendered first (real
 * rendering, not mocked — the same library chat_write_file uses), a format
 * nothing can produce is refused with what to write instead, and a bad
 * filename is refused before anything is rendered or staged.
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: jest.fn(() => ({ url: 'http://sandbox.internal:8092', key: 'k' })),
  sandboxBrowserEnabled: jest.fn(() => false),
  sandboxWorkspacesEnabled: jest.fn(() => false),
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

const STAGED = {
  id: '22222222-2222-4222-8222-222222222222',
  filename: 'brief.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: 100,
  source: 'docgen',
  batchId: null,
  createdAt: '2026-09-04T00:00:00Z',
  expiresAt: '2026-09-05T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sandbox_render_document', () => {
  it('is an act tool', () => {
    const tools = collect(context());
    expect(tools.get('sandbox_render_document')?.config.annotations?.readOnlyHint).toBe(false);
  });

  it('stages a text format exactly as written', async () => {
    client.sbWriteFile.mockResolvedValue({
      ok: true,
      val: { ...STAGED, filename: 'notes.md', contentType: 'text/markdown' },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_render_document')!
      .handler({ filename: 'notes.md', content: '# Sprint notes\n\nDone.' });

    expect(result.isError).toBeUndefined();
    expect(client.sbWriteFile).toHaveBeenCalledTimes(1);
    const [target, meta, bytes] = client.sbWriteFile.mock.calls[0] as [
      unknown,
      { filename: string; contentType: string; source: string },
      Uint8Array,
    ];
    expect(target).toEqual({ tenantId: 'tenant-1', subject: 'auth0|alice' });
    expect(meta).toEqual({ filename: 'notes.md', contentType: 'text/markdown', source: 'docgen' });
    expect(Buffer.from(bytes).toString('utf8')).toBe('# Sprint notes\n\nDone.');
    expect(result.content[0]?.text).toMatch(/Staged .*notes\.md/);
    expect(result.content[0]?.text).toMatch(/sandbox_send_to_upload/);
  });

  it('renders a document format from Markdown before staging it', async () => {
    client.sbWriteFile.mockResolvedValue({ ok: true, val: STAGED });
    const tools = collect(context());
    const result = await tools.get('sandbox_render_document')!.handler({
      filename: 'brief.docx',
      content: '# Sprint review\n\n- Item one\n- Item two\n',
    });

    expect(result.isError).toBeUndefined();
    const [, meta, bytes] = client.sbWriteFile.mock.calls[0] as [
      unknown,
      { filename: string; contentType: string; source: string },
      Uint8Array,
    ];
    expect(meta.contentType).toMatch(/wordprocessingml/);
    // A zip, as every Office file is.
    expect(Buffer.from(bytes).subarray(0, 2).toString('latin1')).toBe('PK');
    expect(result.content[0]?.text).toMatch(/Staged .*brief\.docx/);
  });

  it('passes a renderer’s note on to the model', async () => {
    client.sbWriteFile.mockResolvedValue({
      ok: true,
      val: { ...STAGED, filename: 'memo.pdf', contentType: 'application/pdf' },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_render_document')!
      .handler({ filename: 'memo.pdf', content: '# 連携\n\nLinkage.' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/Note: The PDF fonts cover Latin text only/);
  });

  it('refuses a format nothing here can produce, without staging anything', async () => {
    const tools = collect(context());
    const result = await tools
      .get('sandbox_render_document')!
      .handler({ filename: 'report.xls', content: 'a,b' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /\.xls files cannot be written here: write it as \.xlsx instead/
    );
    expect(client.sbWriteFile).not.toHaveBeenCalled();
  });

  it('refuses a path or an empty name before rendering or staging anything', async () => {
    const tools = collect(context());
    for (const filename of ['../etc/passwd', 'a/b.csv', 'a\\b.csv', '', '..']) {
      const result = await tools
        .get('sandbox_render_document')!
        .handler({ filename, content: 'x' });
      expect(result.isError).toBe(true);
    }
    expect(client.sbWriteFile).not.toHaveBeenCalled();
  });

  it('reports the worker client failure when staging fails', async () => {
    client.sbWriteFile.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'quota_exceeded', message: 'scratch space is full' },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_render_document')!
      .handler({ filename: 'notes.txt', content: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('scratch space is full');
  });

  it('refuses without a signed-in identity before touching the worker', async () => {
    const tools = collect(context(''));
    const result = await tools
      .get('sandbox_render_document')!
      .handler({ filename: 'notes.txt', content: 'hi' });

    expect(result.isError).toBe(true);
    expect(client.sbWriteFile).not.toHaveBeenCalled();
  });
});
