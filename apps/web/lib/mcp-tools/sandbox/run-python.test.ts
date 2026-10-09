/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * sandbox_run_python against a scripted worker client: registered only
 * where scripts are enabled, an act tool, an empty script refused before
 * the worker is asked, the run's exit and streams and staged outputs
 * rendered for the model, a non-zero exit or a timeout answered as the
 * error, and the worker's own refusals passed on.
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: jest.fn(() => ({ url: 'http://sandbox.internal:8092', key: 'k' })),
  sandboxBrowserEnabled: jest.fn(() => false),
  sandboxWorkspacesEnabled: jest.fn(() => false),
  sandboxChartsEnabled: jest.fn(() => false),
  sandboxScriptsEnabled: jest.fn(() => true),
  sandboxScriptsServed: jest.fn(() => true),
  sandboxScriptsAllowNetwork: jest.fn(() => false),
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
  sbRunScript: jest.fn(),
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

const INPUT_ID = '11111111-1111-4111-8111-111111111111';
const OUTPUT = {
  id: '22222222-2222-4222-8222-222222222222',
  filename: 'matched.xlsx',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  sizeBytes: 54_321,
  source: 'script',
  batchId: null,
  createdAt: '2026-10-08T00:00:00Z',
  expiresAt: '2026-10-09T00:00:00Z',
};

function ran(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    val: {
      exitCode: 0,
      signal: null,
      stdout: 'matched 4,812 of 5,003 rows\n',
      stderr: '',
      timedOut: false,
      interrupted: false,
      truncated: false,
      durationMs: 2_300,
      timeoutMs: 60_000,
      inputs: [
        { id: INPUT_ID, filename: 'genserve.xlsx', path: 'in/genserve.xlsx', sizeBytes: 900_000 },
      ],
      outputs: [OUTPUT],
      skippedOutputs: [],
      networkIsolated: true,
      uidIsolated: true,
      ...overrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sandbox_run_python', () => {
  it('is an act tool, registered only where scripts are enabled', () => {
    expect(collect(context()).get('sandbox_run_python')?.config.annotations?.readOnlyHint).toBe(
      false
    );
    client.sandboxScriptsServed.mockReturnValueOnce(false);
    expect(collect(context()).has('sandbox_run_python')).toBe(false);
  });

  it('promises no network only where the deployment keeps that promise', () => {
    client.sandboxScriptsAllowNetwork.mockReturnValueOnce(true);
    const shared = collect(context()).get('sandbox_run_python')!.config.description;
    expect(shared).not.toContain('NO network');
    expect(shared).toContain('HAS the sandbox worker’s network access');
    const isolated = collect(context()).get('sandbox_run_python')!.config.description;
    expect(isolated).toContain('NO network');
  });

  it('tells the model where its files are and that there is no network', () => {
    const description = collect(context()).get('sandbox_run_python')!.config.description;
    expect(description).toContain('in/');
    expect(description).toContain('out/');
    expect(description).toContain('NO network');
    expect(description).toContain('pandas');
  });

  it('refuses an empty script without asking the worker', async () => {
    const result = await collect(context()).get('sandbox_run_python')!.handler({ code: '   ' });
    expect(result.isError).toBe(true);
    expect(client.sbRunScript).not.toHaveBeenCalled();
  });

  it('refuses without a signed-in identity', async () => {
    const result = await collect(context(''))
      .get('sandbox_run_python')!
      .handler({ code: 'print(1)' });
    expect(result.isError).toBe(true);
    expect(client.sbRunScript).not.toHaveBeenCalled();
  });

  it('passes the script, the chosen files and the timeout on, and renders the run', async () => {
    client.sbRunScript.mockResolvedValueOnce(ran());
    const result = await collect(context())
      .get('sandbox_run_python')!
      .handler({
        code: 'import pandas as pd\nprint("hi")',
        files: [INPUT_ID],
        timeoutSeconds: 120,
      });
    expect(client.sbRunScript).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', subject: 'auth0|alice' },
      { code: 'import pandas as pd\nprint("hi")', files: [INPUT_ID], timeoutMs: 120_000 }
    );
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain('exit 0 (2.3s)');
    expect(text).toContain('in/genserve.xlsx — 900000 bytes');
    expect(text).toContain('matched 4,812 of 5,003 rows');
    expect(text).toContain(`Staged ${OUTPUT.id} — "matched.xlsx" — 54321 bytes`);
  });

  it('omits files when none are chosen, so the worker copies in every staged file', async () => {
    client.sbRunScript.mockResolvedValueOnce(ran());
    await collect(context()).get('sandbox_run_python')!.handler({ code: 'print(1)', files: [] });
    expect(client.sbRunScript.mock.calls[0]![1]).toEqual({ code: 'print(1)' });
  });

  it('answers a failing script as the error, with its stderr and what was not staged', async () => {
    client.sbRunScript.mockResolvedValueOnce(
      ran({
        exitCode: 1,
        stdout: '',
        stderr: 'KeyError: "MRN"\n',
        outputs: [],
        skippedOutputs: [{ filename: 'partial.csv', reason: 'empty' }],
      })
    );
    const result = await collect(context()).get('sandbox_run_python')!.handler({ code: 'x' });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain('exit 1');
    expect(text).toContain('KeyError: "MRN"');
    expect(text).toContain('partial.csv: empty');
  });

  it('says when the run timed out, was interrupted, or ran without isolation', async () => {
    client.sbRunScript.mockResolvedValueOnce(
      ran({ timedOut: true, exitCode: null, signal: 'SIGKILL' })
    );
    let result = await collect(context()).get('sandbox_run_python')!.handler({ code: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('TIMED OUT after 60s');

    client.sbRunScript.mockResolvedValueOnce(ran({ interrupted: true, exitCode: null }));
    result = await collect(context()).get('sandbox_run_python')!.handler({ code: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INTERRUPTED');

    client.sbRunScript.mockResolvedValueOnce(ran({ networkIsolated: false, uidIsolated: false }));
    result = await collect(context()).get('sandbox_run_python')!.handler({ code: 'x' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('ran WITH the sandbox worker’s network access');
    expect(result.content[0]!.text).toContain('ran as its user');
  });

  it('passes a worker refusal on as the error', async () => {
    client.sbRunScript.mockResolvedValueOnce({
      ok: false,
      err: {
        kind: 'op',
        type: 'busy',
        message: 'A script of yours is already running.',
        status: 429,
      },
    });
    const result = await collect(context()).get('sandbox_run_python')!.handler({ code: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('already running');
  });
});
