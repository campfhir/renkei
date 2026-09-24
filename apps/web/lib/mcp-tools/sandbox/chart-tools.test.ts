/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * sandbox_render_chart against a scripted worker client: registered only
 * where charts are enabled, an act tool, the request checked and defaulted
 * before the worker is asked (a bad option or filename is refused without
 * a call), the staged file answered with its size and kind, and a worker
 * refusal — Mermaid's parse error among them — passed on as the error.
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: jest.fn(() => ({ url: 'http://sandbox.internal:8092', key: 'k' })),
  sandboxBrowserEnabled: jest.fn(() => false),
  sandboxWorkspacesEnabled: jest.fn(() => false),
  sandboxChartsEnabled: jest.fn(() => true),
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
  sbChartStage: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerSandboxTools } from './index';
import type { MCPToolContext } from '../common';

const client = jest.requireMock<Record<string, jest.Mock>>('@/lib/sandbox/service-client');

type Handler = (
  args: Record<string, unknown>
) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface Registered {
  config: { annotations?: { readOnlyHint?: boolean }; description: string };
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
  file: {
    id: '22222222-2222-4222-8222-222222222222',
    filename: 'sales.png',
    contentType: 'image/png',
    sizeBytes: 4321,
    source: 'chart:xychart',
    batchId: null,
    createdAt: '2026-09-04T00:00:00Z',
    expiresAt: '2026-09-05T00:00:00Z',
  },
  width: 732,
  height: 532,
  diagramType: 'xychart',
};

const SOURCE = 'xychart-beta\n  x-axis [Q1, Q2]\n  bar [1, 2]';

beforeEach(() => {
  jest.clearAllMocks();
  client.sandboxChartsEnabled.mockReturnValue(true);
});

describe('sandbox_render_chart', () => {
  it('is an act tool that explains Mermaid text, registered only where charts are enabled', () => {
    const tools = collect(context());
    const tool = tools.get('sandbox_render_chart');
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
    expect(tool?.config.description).toMatch(/xychart-beta/);
    expect(tool?.config.description).toMatch(/sandbox_send_to_upload/);

    client.sandboxChartsEnabled.mockReturnValue(false);
    expect(collect(context()).has('sandbox_render_chart')).toBe(false);
  });

  it('stages the chart with the request checked and defaulted, and answers the file and its size', async () => {
    client.sbChartStage.mockResolvedValue({ ok: true, val: STAGED });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_render_chart')!
      .handler({ source: SOURCE, filename: 'sales' });

    expect(result.isError).toBeUndefined();
    expect(client.sbChartStage).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', subject: 'auth0|alice' },
      {
        source: SOURCE,
        format: 'png',
        theme: 'default',
        background: '#ffffff',
        scale: 2,
        filename: 'sales.png',
      }
    );
    expect(result.content[0]?.text).toMatch(/Staged .*sales\.png/);
    expect(result.content[0]?.text).toMatch(/a xychart diagram, 732×532 px/);
    expect(result.content[0]?.text).toMatch(/sandbox_send_to_upload/);
  });

  it('carries every option through, correcting the filename’s extension to the format', async () => {
    client.sbChartStage.mockResolvedValue({ ok: true, val: STAGED });
    const tools = collect(context());
    await tools.get('sandbox_render_chart')!.handler({
      source: SOURCE,
      format: 'pdf',
      theme: 'dark',
      background: 'transparent',
      scale: 3,
      filename: 'plan.png',
    });
    expect(client.sbChartStage.mock.calls[0]?.[1]).toEqual({
      source: SOURCE,
      format: 'pdf',
      theme: 'dark',
      // A PDF page is always painted.
      background: '#ffffff',
      scale: 3,
      filename: 'plan.pdf',
    });
  });

  it('refuses a bad option or a path before asking the worker', async () => {
    const tools = collect(context());
    const handler = tools.get('sandbox_render_chart')!.handler;
    const badTheme = await handler({ source: SOURCE, theme: 'solarized' });
    expect(badTheme.isError).toBe(true);
    expect(badTheme.content[0]?.text).toMatch(/theme must be one of/);
    const badBackground = await handler({ source: SOURCE, background: 'url(x)' });
    expect(badBackground.isError).toBe(true);
    const path = await handler({ source: SOURCE, filename: '../escape' });
    expect(path.isError).toBe(true);
    expect(path.content[0]?.text).toMatch(/filename must be a name/);
    const empty = await handler({ source: '   ' });
    expect(empty.isError).toBe(true);
    expect(client.sbChartStage).not.toHaveBeenCalled();
  });

  it('passes the worker’s refusal on — Mermaid’s parse error included', async () => {
    client.sbChartStage.mockResolvedValue({
      ok: false,
      err: {
        kind: 'op',
        type: 'invalid_diagram',
        message: 'Mermaid could not draw this diagram: Parse error on line 2',
      },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_render_chart')!
      .handler({ source: 'flowchart LR\n  A --> ' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Parse error on line 2/);
  });

  it('refuses without a signed-in identity before touching the worker', async () => {
    const tools = collect(context(''));
    const result = await tools.get('sandbox_render_chart')!.handler({ source: SOURCE });
    expect(result.isError).toBe(true);
    expect(client.sbChartStage).not.toHaveBeenCalled();
  });
});
