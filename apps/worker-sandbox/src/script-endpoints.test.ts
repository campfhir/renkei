/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any */
/**
 * The script verb over the wire: closed when not enabled, the body
 * checked before the runner is asked, a refusal mapped to its status,
 * and a run's outcome answered in the wire shape. The runner is scripted;
 * the HTTP seam is the subject.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { createSandboxServer } from './server';
import { ScriptRunError, type ScriptRunner } from './scripts';

const API_KEY = 'test-worker-key';
const TARGET = { tenantId: 'tenant-1', subject: 'alice' };
const FILE_ID = '11111111-1111-4111-8111-111111111111';

const run = jest.fn();
const runner = { run } as unknown as ScriptRunner;

let enabledServer: Server;
let disabledServer: Server;
let enabledBase: string;
let disabledBase: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(base: string, op: string, body: unknown) {
  const response = await fetch(`${base}/v1/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

beforeAll(async () => {
  enabledServer = createSandboxServer({
    db: {} as Kysely<DB>,
    apiKeys: [API_KEY],
    scripts: runner,
  });
  disabledServer = createSandboxServer({ db: {} as Kysely<DB>, apiKeys: [API_KEY] });
  enabledBase = await listen(enabledServer);
  disabledBase = await listen(disabledServer);
});

afterAll(async () => {
  await new Promise((resolve) => enabledServer.close(resolve));
  await new Promise((resolve) => disabledServer.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('/v1/scripts/run', () => {
  it('is closed where scripts are not enabled', async () => {
    const { status, json } = await post(disabledBase, 'scripts/run', {
      ...TARGET,
      code: 'print(1)',
    });
    expect(status).toBe(503);
    expect(json.error.type).toBe('scripts_unavailable');
  });

  it('requires a bearer key', async () => {
    const response = await fetch(`${enabledBase}/v1/scripts/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...TARGET, code: 'print(1)' }),
    });
    expect(response.status).toBe(401);
  });

  it('checks the body before the runner is asked', async () => {
    expect((await post(enabledBase, 'scripts/run', { code: 'print(1)' })).status).toBe(400);
    expect((await post(enabledBase, 'scripts/run', { ...TARGET, code: '' })).status).toBe(400);
    expect(
      (await post(enabledBase, 'scripts/run', { ...TARGET, code: 'print(1)', files: ['nope'] }))
        .status
    ).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('answers an unknown script verb 404', async () => {
    expect((await post(enabledBase, 'scripts/stop', TARGET)).status).toBe(404);
  });

  it('runs the script with the caller’s target, files and bounded timeout, and answers the outcome', async () => {
    run.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: 'ok\n',
      stderr: '',
      timedOut: false,
      interrupted: false,
      truncated: false,
      durationMs: 120,
      timeoutMs: 5_000,
      inputs: [{ id: FILE_ID, filename: 'r.csv', path: 'in/r.csv', sizeBytes: 3 }],
      outputs: [
        {
          id: 'out-1',
          filename: 'm.csv',
          contentType: 'text/csv',
          sizeBytes: 9,
          source: 'script',
          batchId: null,
          createdAt: new Date('2026-10-08T00:00:00Z'),
          expiresAt: new Date('2026-10-09T00:00:00Z'),
        },
      ],
      skippedOutputs: [{ filename: 'x', reason: 'empty' }],
      networkIsolated: true,
      uidIsolated: true,
    });
    const { status, json } = await post(enabledBase, 'scripts/run', {
      ...TARGET,
      code: 'print("ok")',
      files: [FILE_ID, FILE_ID],
      timeoutMs: 5_000,
    });
    expect(status).toBe(200);
    expect(run).toHaveBeenCalledWith(
      TARGET,
      expect.objectContaining({ code: 'print("ok")', fileIds: [FILE_ID], timeoutMs: 5_000 })
    );
    expect(run.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(json).toMatchObject({
      exitCode: 0,
      stdout: 'ok\n',
      inputs: [{ path: 'in/r.csv' }],
      outputs: [{ id: 'out-1', filename: 'm.csv', createdAt: '2026-10-08T00:00:00.000Z' }],
      skippedOutputs: [{ filename: 'x', reason: 'empty' }],
      networkIsolated: true,
    });
  });

  it('bounds the timeout and reads an absent files list as "every staged file"', async () => {
    run.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      interrupted: false,
      truncated: false,
      durationMs: 1,
      timeoutMs: 600_000,
      inputs: [],
      outputs: [],
      skippedOutputs: [],
      networkIsolated: false,
      uidIsolated: false,
    });
    await post(enabledBase, 'scripts/run', { ...TARGET, code: 'print(1)', timeoutMs: 99_999_999 });
    expect(run.mock.calls[0]![1]).toMatchObject({ fileIds: null, timeoutMs: 600_000 });
  });

  it('maps the runner’s refusals to their statuses', async () => {
    for (const [type, status] of [
      ['not_found', 404],
      ['too_large', 413],
      ['busy', 429],
    ] as const) {
      run.mockRejectedValueOnce(new ScriptRunError({ type, message: `because ${type}` }));
      const answer = await post(enabledBase, 'scripts/run', { ...TARGET, code: 'print(1)' });
      expect(answer.status).toBe(status);
      expect(answer.json.error).toEqual({ type, message: `because ${type}` });
    }
  });
});
