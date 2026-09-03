/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The sandbox_browser_* tools against a scripted worker client: they
 * register only when the deployment enables the browser, each verb hands
 * the worker the caller's own target plus its arguments and answers with
 * the snapshot, a worker refusal becomes a clean errText(), and a caller
 * with no identity is refused before any call.
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: jest.fn(() => ({ url: 'http://sandbox.internal:8092', key: 'k' })),
  sandboxBrowserEnabled: jest.fn(() => true),
  clientFailure: jest.fn((error: { kind: string; type?: string; message?: string }) => ({
    status: 400,
    message: error.message ?? `failed: ${error.type ?? error.kind}`,
  })),
  sbBrowserNavigate: jest.fn(),
  sbBrowserSnapshot: jest.fn(),
  sbBrowserClick: jest.fn(),
  sbBrowserType: jest.fn(),
  sbBrowserSelect: jest.fn(),
  sbBrowserPress: jest.fn(),
  sbBrowserBack: jest.fn(),
  sbBrowserScreenshot: jest.fn(),
  sbBrowserClose: jest.fn(),
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
const PAGE = {
  url: 'https://example.com/',
  title: 'Example',
  snapshot: 'Page: Example\nURL: https://example.com/\n---\n# Hi',
  truncated: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  client.sandboxBrowserEnabled.mockReturnValue(true);
});

describe('registration', () => {
  it('registers the browser verbs beside the file tools when the browser is enabled', () => {
    const tools = collect(context());
    const names = [...tools.keys()].filter((name) => name.startsWith('sandbox_browser_'));
    expect(names.sort()).toEqual([
      'sandbox_browser_back',
      'sandbox_browser_click',
      'sandbox_browser_close',
      'sandbox_browser_navigate',
      'sandbox_browser_press_key',
      'sandbox_browser_screenshot',
      'sandbox_browser_select',
      'sandbox_browser_snapshot',
      'sandbox_browser_type',
    ]);
    expect(tools.has('sandbox_download_url')).toBe(true);
    expect(tools.get('sandbox_browser_snapshot')?.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('sandbox_browser_navigate')?.config.annotations?.readOnlyHint).toBe(false);
  });

  it('registers none of them when the deployment has no browser', () => {
    client.sandboxBrowserEnabled.mockReturnValue(false);
    const tools = collect(context());
    expect([...tools.keys()].some((name) => name.startsWith('sandbox_browser_'))).toBe(false);
    expect(tools.has('sandbox_download_url')).toBe(true);
  });
});

describe('verbs', () => {
  it('navigate hands the worker the caller target and answers the snapshot', async () => {
    client.sbBrowserNavigate.mockResolvedValue({ ok: true, val: PAGE });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_browser_navigate')!
      .handler({ url: 'https://example.com/', maxChars: 500 });
    expect(client.sbBrowserNavigate).toHaveBeenCalledWith(TARGET, {
      url: 'https://example.com/',
      maxChars: 500,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(PAGE.snapshot);
  });

  it('each action passes its arguments through', async () => {
    for (const name of [
      'sbBrowserSnapshot',
      'sbBrowserClick',
      'sbBrowserType',
      'sbBrowserSelect',
      'sbBrowserPress',
      'sbBrowserBack',
    ]) {
      client[name].mockResolvedValue({ ok: true, val: PAGE });
    }
    const tools = collect(context());
    await tools.get('sandbox_browser_snapshot')!.handler({});
    expect(client.sbBrowserSnapshot).toHaveBeenCalledWith(TARGET, { maxChars: undefined });
    await tools.get('sandbox_browser_click')!.handler({ ref: 'e3' });
    expect(client.sbBrowserClick).toHaveBeenCalledWith(TARGET, { ref: 'e3', maxChars: undefined });
    await tools.get('sandbox_browser_type')!.handler({ ref: 'e4', text: 'renkei', submit: true });
    expect(client.sbBrowserType).toHaveBeenCalledWith(TARGET, {
      ref: 'e4',
      text: 'renkei',
      submit: true,
      maxChars: undefined,
    });
    await tools.get('sandbox_browser_select')!.handler({ ref: 'e5', values: ['Blue', 'b'] });
    expect(client.sbBrowserSelect).toHaveBeenCalledWith(TARGET, {
      ref: 'e5',
      values: ['Blue', 'b'],
      maxChars: undefined,
    });
    await tools.get('sandbox_browser_press_key')!.handler({ key: 'Escape', maxChars: 1000 });
    expect(client.sbBrowserPress).toHaveBeenCalledWith(TARGET, { key: 'Escape', maxChars: 1000 });
    await tools.get('sandbox_browser_back')!.handler({});
    expect(client.sbBrowserBack).toHaveBeenCalledWith(TARGET, { maxChars: undefined });
  });

  it('screenshot names the staged file and where it was taken', async () => {
    client.sbBrowserScreenshot.mockResolvedValue({
      ok: true,
      val: {
        file: {
          id: 'shot-1',
          filename: 'home.png',
          contentType: 'image/png',
          sizeBytes: 8704,
          source: 'browser:example.com',
          batchId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
        },
        url: 'https://example.com/',
        title: 'Example',
      },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_browser_screenshot')!
      .handler({ fullPage: true, filename: 'home.png' });
    expect(client.sbBrowserScreenshot).toHaveBeenCalledWith(TARGET, {
      fullPage: true,
      filename: 'home.png',
    });
    expect(result.content[0].text).toContain('shot-1');
    expect(result.content[0].text).toContain('screenshot of https://example.com/');
  });

  it('close reports whether a session existed', async () => {
    client.sbBrowserClose.mockResolvedValueOnce({ ok: true, val: { closed: false } });
    const tools = collect(context());
    const result = await tools.get('sandbox_browser_close')!.handler({});
    expect(result.content[0].text).toBe('No browser session was open.');
  });

  it('turns a worker refusal into an error result with its message', async () => {
    client.sbBrowserClick.mockResolvedValue({
      ok: false,
      err: {
        kind: 'op',
        type: 'bad_ref',
        message: 'No element carries ref e9 on the current page — take a new snapshot.',
        status: 400,
      },
    });
    const tools = collect(context());
    const result = await tools.get('sandbox_browser_click')!.handler({ ref: 'e9' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('take a new snapshot');
  });

  it('refuses a caller with no identity before calling the worker', async () => {
    const tools = collect(context(''));
    const result = await tools
      .get('sandbox_browser_navigate')!
      .handler({ url: 'https://example.com/' });
    expect(result.isError).toBe(true);
    expect(client.sbBrowserNavigate).not.toHaveBeenCalled();
  });
});
