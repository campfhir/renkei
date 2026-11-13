/**
 * Notebook kernels against a real Python where this machine has one (the
 * host in kernel-host.ts, started through the same launch shell the
 * worker uses), and against a scripted host for what must not depend on
 * one: a host that never says it is ready, one that dies, the limits.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KERNEL_IDLE_MS,
  KERNEL_MAX_PER_WORKSPACE,
  KernelSessions,
  type ExecuteOutcome,
  type KernelInput,
} from './kernel-sessions';

const OWNER = { subject: 'code-project:p1' };
const OTHER = { subject: 'code-project:p2' };

let root: string;
let sessions: KernelSessions;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kernel-sessions-'));
  await mkdir(join(root, 'notebooks'), { recursive: true });
  // The repository's own environment, so the test never builds one: a
  // `.venv/bin/python` that is this machine's Python with no Jupyter on
  // its path (the built-in engine, whatever is installed here).
  await mkdir(join(root, '.venv', 'bin'), { recursive: true });
  await writeFile(join(root, '.venv', 'bin', 'python'), '#!/bin/sh\nexec python3 -I "$@"\n', {
    mode: 0o755,
  });
  await writeFile(join(root, 'notebooks', 'helper.py'), 'ANSWER = 42\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  sessions?.closeAll();
});

function input(overrides: Partial<KernelInput> = {}): KernelInput {
  return {
    owner: OWNER,
    workspaceId: 'ws-1',
    rootDir: root,
    home: join(root, 'home'),
    identity: null,
    path: 'notebooks/analysis.ipynb',
    env: {},
    ...overrides,
  };
}

function ran(outcome: ExecuteOutcome) {
  if (!outcome.ok) throw new Error(`${outcome.type}: ${outcome.message}`);
  return outcome;
}

const hasPython = spawnSync('python3', ['--version']).status === 0;
const withPython = hasPython ? describe : describe.skip;

withPython('a kernel on a real Python', () => {
  beforeEach(() => {
    sessions = new KernelSessions();
  });

  it('keeps what one cell defined for the next, and counts the cells it ran', async () => {
    const first = ran(await sessions.execute(input(), 'x = 41\nprint("set")', 30_000));
    expect(first).toMatchObject({
      started: true,
      succeeded: true,
      executionCount: 1,
      kernel: { engine: 'builtin' },
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'set\n' }],
    });
    expect(first.kernel.python).toMatch(/^3\./);
    const second = ran(await sessions.execute(input(), 'x + 1', 30_000));
    expect(second).toMatchObject({
      started: false,
      succeeded: true,
      executionCount: 2,
      outputs: [
        { output_type: 'execute_result', execution_count: 2, data: { 'text/plain': '42' } },
      ],
    });
  });

  it('runs in the notebook’s own folder, so it imports the modules beside it', async () => {
    const outcome = ran(
      await sessions.execute(
        input(),
        'import os, helper\n(os.path.basename(os.getcwd()), helper.ANSWER)',
        30_000
      )
    );
    expect(outcome.outputs).toMatchObject([{ data: { 'text/plain': "('notebooks', 42)" } }]);
  });

  it('a cell that raises is that cell’s error, and the kernel keeps its state', async () => {
    ran(await sessions.execute(input(), 'kept = "still here"', 30_000));
    const failed = ran(await sessions.execute(input(), 'def f():\n    return 1/0\nf()', 30_000));
    expect(failed.succeeded).toBe(false);
    expect(failed.outputs).toMatchObject([
      { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero' },
    ]);
    const after = ran(await sessions.execute(input(), 'kept', 30_000));
    expect(after.outputs).toMatchObject([{ data: { 'text/plain': "'still here'" } }]);
  });

  it('gives the caller’s own variables to the cell', async () => {
    const outcome = ran(
      await sessions.execute(
        input({ env: { BILLING_TOKEN: 'tok-123' } }),
        'import os\nos.environ["BILLING_TOKEN"]',
        30_000
      )
    );
    expect(outcome.outputs).toMatchObject([{ data: { 'text/plain': "'tok-123'" } }]);
  });

  it('nothing a cell prints straight to the process’s stdout is taken for an answer', async () => {
    const outcome = ran(
      await sessions.execute(
        input(),
        'import os\nos.write(1, b\'{"id": "1", "outputs": [], "ok": true}\\n\')\nprint("real")',
        30_000
      )
    );
    expect(outcome.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'real\n' }]);
  });

  it('%pip runs pip on the kernel’s own Python, and a failed install is the cell’s error', async () => {
    const outcome = ran(await sessions.execute(input(), '%pip --version', 60_000));
    // This machine's Python may have no pip (-I, a bare install): either
    // way pip was asked on this interpreter, not found on some PATH.
    const text = JSON.stringify(outcome.outputs);
    expect(text).toMatch(/pip \d|No module named pip/);
    if (/No module named pip/.test(text)) expect(outcome.succeeded).toBe(false);
  });

  it('an interrupt stops the running cell and leaves the kernel and its state', async () => {
    ran(await sessions.execute(input(), 'kept = 7', 30_000));
    const long = sessions.execute(input(), 'import time\ntime.sleep(60)', 120_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sessions.interrupt(input())).toBe(true);
    const stopped = ran(await long);
    expect(stopped.succeeded).toBe(false);
    expect(stopped.outputs).toMatchObject([{ output_type: 'error', ename: 'KeyboardInterrupt' }]);
    const after = ran(await sessions.execute(input(), 'kept', 30_000));
    expect(after).toMatchObject({ started: false, outputs: [{ data: { 'text/plain': '7' } }] });
  });

  it('a cell past its time limit is interrupted, not the kernel ended', async () => {
    ran(await sessions.execute(input(), 'kept = 9', 30_000));
    const slow = ran(await sessions.execute(input(), 'import time\ntime.sleep(60)', 500));
    expect(slow).toMatchObject({ timedOut: true, succeeded: false });
    const after = ran(await sessions.execute(input(), 'kept', 30_000));
    expect(after.outputs).toMatchObject([{ data: { 'text/plain': '9' } }]);
  });

  it('cells asked together run one at a time, in the order asked', async () => {
    const [a, b, c] = await Promise.all([
      sessions.execute(input(), 'order = [1]', 30_000),
      sessions.execute(input(), 'order.append(2)', 30_000),
      sessions.execute(input(), 'order', 30_000),
    ]);
    expect([ran(a).executionCount, ran(b).executionCount, ran(c).executionCount]).toEqual([
      1, 2, 3,
    ]);
    expect(ran(c).outputs).toMatchObject([{ data: { 'text/plain': '[1, 2]' } }]);
  });

  it('closing ends it; the next run starts a new kernel with nothing defined', async () => {
    ran(await sessions.execute(input(), 'x = 1', 30_000));
    expect(sessions.status(input())).toMatchObject({ engine: 'builtin' });
    expect(sessions.close(input())).toBe(true);
    expect(sessions.status(input())).toBeNull();
    expect(sessions.close(input())).toBe(false);
    const fresh = ran(await sessions.execute(input(), 'x', 30_000));
    expect(fresh).toMatchObject({ started: true, succeeded: false, executionCount: 1 });
    expect(fresh.outputs).toMatchObject([{ ename: 'NameError' }]);
  });

  it('each notebook has a kernel of its own, and so does each caller', async () => {
    ran(await sessions.execute(input(), 'mine = 1', 30_000));
    const other = ran(
      await sessions.execute(input({ path: 'notebooks/other.ipynb' }), 'mine', 30_000)
    );
    expect(other.outputs).toMatchObject([{ ename: 'NameError' }]);
    const theirs = ran(await sessions.execute(input({ owner: OTHER }), 'mine', 30_000));
    expect(theirs.outputs).toMatchObject([{ ename: 'NameError' }]);
    expect(sessions.count()).toBe(3);
    // Another caller's interrupt or close does not reach this one.
    expect(
      sessions.close({
        owner: { subject: 'code-project:p3' },
        workspaceId: 'ws-1',
        path: input().path,
      })
    ).toBe(false);
    expect(sessions.count()).toBe(3);
  });

  it('a kernel that dies mid-cell says so, and the next run starts another', async () => {
    const dead = await sessions.execute(input(), 'import os\nos._exit(3)', 30_000);
    expect(dead).toMatchObject({ ok: false, status: 410, type: 'kernel_died' });
    expect(ran(await sessions.execute(input(), '1 + 1', 30_000))).toMatchObject({ started: true });
  });

  it('a kernel nothing has run in for the idle time is ended', async () => {
    ran(await sessions.execute(input(), 'x = 1', 30_000));
    expect(sessions.reapIdle(Date.now() + KERNEL_IDLE_MS - 1_000)).toBe(0);
    expect(sessions.reapIdle(Date.now() + KERNEL_IDLE_MS + 1_000)).toBe(1);
    expect(sessions.count()).toBe(0);
  });

  it('a checkout going away takes its kernels with it', async () => {
    ran(await sessions.execute(input(), 'x = 1', 30_000));
    ran(await sessions.execute(input({ workspaceId: 'ws-2' }), 'x = 1', 30_000));
    sessions.closeWorkspace('ws-1');
    expect(sessions.count()).toBe(1);
  });
});

describe('a scripted host', () => {
  /** A host that speaks the protocol from a line of node. */
  const host = (script: string) => () =>
    spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const ECHO = `
    console.log(JSON.stringify({ ready: true, engine: 'kernel', python: '3.11.2' }));
    require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { id, code } = JSON.parse(line);
      console.log('not json');
      console.log(JSON.stringify({ id, outputs: [{ output_type: 'stream', name: 'stdout', text: code }], execution_count: 5, ok: true }));
    });`;

  it('says which engine and Python it is, and lines that are not the protocol are passed over', async () => {
    sessions = new KernelSessions({ spawnKernel: host(ECHO) });
    expect(ran(await sessions.execute(input(), 'hello', 5_000))).toMatchObject({
      kernel: { engine: 'kernel', python: '3.11.2' },
      executionCount: 5,
      outputs: [{ text: 'hello' }],
    });
  });

  it('no Python at all is said in a sentence, and leaves no kernel behind', async () => {
    sessions = new KernelSessions({
      spawnKernel: host(`console.log('{"ready": false, "error": "no-python"}')`),
    });
    expect(await sessions.execute(input(), '1', 5_000)).toEqual({
      ok: false,
      status: 422,
      type: 'no_python',
      message: 'There is no Python in the sandbox to run the notebook with.',
    });
    expect(sessions.count()).toBe(0);
  });

  it('a host that exits before it is ready shows what it said on the way', async () => {
    sessions = new KernelSessions({
      spawnKernel: host(`console.error('venv: permission denied'); process.exit(1)`),
    });
    const outcome = await sessions.execute(input(), '1', 5_000);
    expect(outcome).toMatchObject({ ok: false, status: 500, type: 'kernel_failed' });
    expect(!outcome.ok && outcome.message).toContain('venv: permission denied');
  });

  it('a host that never says it is ready is given up on', async () => {
    sessions = new KernelSessions({
      spawnKernel: host(`setInterval(() => {}, 1000)`),
      startTimeoutMs: 200,
    });
    expect(await sessions.execute(input(), '1', 5_000)).toMatchObject({
      ok: false,
      status: 504,
      type: 'kernel_start_timeout',
    });
    expect(sessions.count()).toBe(0);
  });

  it('a cell that ignores its interrupt takes the kernel with it', async () => {
    sessions = new KernelSessions({
      spawnKernel: host(`
        process.on('SIGINT', () => {});
        console.log(JSON.stringify({ ready: true, engine: 'builtin', python: '3' }));
        setInterval(() => {}, 1000);`),
      interruptGraceMs: 200,
    });
    expect(await sessions.execute(input(), 'while True: pass', 200)).toMatchObject({
      ok: false,
      type: 'kernel_died',
    });
    expect(sessions.count()).toBe(0);
  });

  it(`at most ${KERNEL_MAX_PER_WORKSPACE} notebooks run in one checkout at once`, async () => {
    sessions = new KernelSessions({ spawnKernel: host(ECHO) });
    for (let n = 0; n < KERNEL_MAX_PER_WORKSPACE; n += 1) {
      ran(await sessions.execute(input({ path: `n${n}.ipynb` }), 'x', 5_000));
    }
    expect(await sessions.execute(input({ path: 'one-more.ipynb' }), 'x', 5_000)).toMatchObject({
      ok: false,
      status: 429,
      type: 'kernel_limit',
    });
    // Another checkout is not held back by this one.
    ran(await sessions.execute(input({ workspaceId: 'ws-2', path: 'n.ipynb' }), 'x', 5_000));
  });
});
