/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The script runner against a real interpreter and a real temporary
 * disk: inputs copied in by name and read-only, outputs staged back under
 * the quota with what could not be named with why, the run directory
 * gone afterwards, a missing input refused before anything runs, the wall
 * clock and the memory ceiling honoured, one run per caller at a time —
 * and, where this process is root and the kernel allows it, no network
 * and no reach into the staged-file disk. The store is mocked; the disk
 * is real.
 */

jest.mock('./store', () => ({
  insertFile: jest.fn(),
  listFiles: jest.fn(),
  totalStagedBytes: jest.fn(),
  countFiles: jest.fn(),
  totalStagedBytesForBatch: jest.fn(),
  countFilesForBatch: jest.fn(),
  getFile: jest.fn(),
}));

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import * as disk from './disk';
import {
  NETWORK_ISOLATION_MODES,
  canIsolateByUid,
  probeNetworkIsolation,
  verifyNetworkIsolation,
  type NetworkIsolation,
} from './workspaces';
import {
  DEFAULT_PYTHON,
  ScriptRunError,
  ScriptRunner,
  decideScripts,
  resolvePython,
  scriptCommand,
  scriptEnvironment,
} from './scripts';

const store = jest.requireMock<Record<string, jest.Mock>>('./store');

/** Decided when the file loads, since `it.skip` must be chosen before any hook runs. */
const PYTHON_AVAILABLE =
  existsSync(DEFAULT_PYTHON) || spawnSync('python3', ['--version']).status === 0;
const itWithPython = PYTHON_AVAILABLE ? it : it.skip;

const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const OTHER = { tenantId: 'tenant-1', subject: 'auth0|bob' };
const REPORT_ID = '11111111-1111-4111-8111-111111111111';
const LOOKUP_ID = '22222222-2222-4222-8222-222222222222';

let root: string;
let runsRoot: string;
let previousUmask: number;
let python: string | null;
let networkIsolation: NetworkIsolation | null;
let networkIsolated: boolean;
let runner: ScriptRunner;
const staged = new Map<
  string,
  { id: string; filename: string; contentType: string | null; storageKey: string }
>();

async function stage(id: string, filename: string, content: string): Promise<void> {
  const storageKey = disk.newStorageKey(TARGET.tenantId, TARGET.subject);
  await disk.writeStream(storageKey, Readable.from([Buffer.from(content)]), 1_048_576);
  staged.set(id, { id, filename, contentType: null, storageKey });
}

beforeAll(async () => {
  // The worker raises its umask before it stages anything (index.ts), so
  // the staged-file disk is root's alone; the same here, or the "cannot
  // reach the staged bytes" property below would be the test's umask
  // rather than the worker's.
  previousUmask = process.umask(0o077);
  root = await mkdtemp(join(tmpdir(), 'renkei-scripts-'));
  // A dropped uid must be able to walk through to its run directory,
  // as it can through /runs on the image; mkdtemp makes the root 0700.
  await chmod(root, 0o711);
  disk.setDataRootForTests(join(root, 'data'));
  await disk.ensureDataRoot();
  runsRoot = join(root, 'runs');
  python = await resolvePython(undefined);
  networkIsolation = (await verifyNetworkIsolation()).mode;
  networkIsolated = networkIsolation !== null;
  await stage(REPORT_ID, 'report.csv', 'mrn,name,phone\n1001,Ada,415-0100\n1002,Grace,\n');
  await stage(LOOKUP_ID, 'report.csv', 'mrn,text_ok\n1001,Y\n1002,N\n');
  runner = new ScriptRunner({
    db: {} as Kysely<DB>,
    runsRoot,
    python: python ?? 'python3',
    networkIsolation,
    memoryBytes: 512 * 1_048_576,
    maxFileBytes: async () => 1_048_576,
  });
  await runner.prepare();
});

/** A runner like the suite's, in one isolation mode. */
function runnerIn(mode: NetworkIsolation | null): ScriptRunner {
  return new ScriptRunner({
    db: {} as Kysely<DB>,
    runsRoot,
    python: python ?? 'python3',
    networkIsolation: mode,
    memoryBytes: 512 * 1_048_576,
    maxFileBytes: async () => 1_048_576,
  });
}

/** Python that reports whether a socket can leave and what uid it runs as. */
const NETWORK_PROBE = [
  'import os, socket',
  'print("uid", os.getuid())',
  's = socket.socket(); s.settimeout(2)',
  'try:',
  '    s.connect(("1.1.1.1", 443)); print("net reachable")',
  'except OSError as e:',
  '    print("net blocked:", type(e).__name__)',
].join('\n');

afterAll(async () => {
  process.umask(previousUmask);
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  store.countFiles.mockResolvedValue(0);
  store.totalStagedBytes.mockResolvedValue(0);
  store.getFile.mockImplementation(async (_db: unknown, target: typeof TARGET, id: string) =>
    target.subject === TARGET.subject ? staged.get(id) : undefined
  );
  store.listFiles.mockImplementation(async (_db: unknown, target: typeof TARGET) =>
    target.subject === TARGET.subject ? [...staged.values()].map((file) => ({ id: file.id })) : []
  );
  store.insertFile.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    id: `staged-${input.filename}`,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    source: input.source,
    batchId: null,
    createdAt: new Date(),
    expiresAt: input.expiresAt,
  }));
});

describe('the configured interpreter', () => {
  it('accepts a command name or a plain absolute path', async () => {
    expect(await resolvePython('python3')).toBe('python3');
    expect(await resolvePython('  python3.12  ')).toBe('python3.12');
    // A path is only returned when it is executable; a plain one that is
    // not falls through to the defaults rather than being refused.
    const fallback = await resolvePython('/opt/no-such-python/bin/python3');
    expect(fallback === null || !fallback.startsWith('/opt/no-such')).toBe(true);
  });

  it('refuses a path a shell or ps would misread', async () => {
    for (const odd of ['python3; id', '/opt/py thon/bin/python3', 'relative/python3', '$HOME/py']) {
      await expect(resolvePython(odd)).rejects.toThrow(/SANDBOX_PYTHON must be/);
    }
  });
});

describe('the boot decision for scripts', () => {
  it('serves isolated runs whichever way the namespace is made', () => {
    for (const mode of NETWORK_ISOLATION_MODES) {
      expect(decideScripts({ enabled: true, networkIsolation: mode, allowNetwork: false })).toEqual(
        { status: 'isolated', serve: true, unavailable: null }
      );
      // The opt-in changes nothing where isolation works.
      expect(
        decideScripts({ enabled: true, networkIsolation: mode, allowNetwork: true }).status
      ).toBe('isolated');
    }
  });

  it('closes the verb when no isolation works and nobody opted in', () => {
    const decision = decideScripts({ enabled: true, networkIsolation: null, allowNetwork: false });
    expect(decision.status).toBe('unavailable');
    expect(decision.serve).toBe(false);
    expect(decision.unavailable).toMatch(/cannot start a script without network access/);
  });

  it('serves runs on the container’s network only with the explicit opt-in, and says so', () => {
    expect(decideScripts({ enabled: true, networkIsolation: null, allowNetwork: true })).toEqual({
      status: 'network_shared',
      serve: true,
      unavailable: null,
    });
  });

  it('is simply disabled when the flag is off, whatever else is true', () => {
    expect(
      decideScripts({ enabled: false, networkIsolation: 'netns', allowNetwork: true })
    ).toEqual({ status: 'disabled', serve: false, unavailable: null });
  });
});

describe('the command a script runs behind', () => {
  it('caps processes, file size and address space, then execs the interpreter in isolated mode', () => {
    const command = scriptCommand('/opt/py/bin/python3', 2 * 1_073_741_824);
    expect(command).toMatch(/^ulimit -u 64 -f \d+ -v 2097152 -c 0/);
    expect(command).toContain(`exec '/opt/py/bin/python3' -I -B main.py`);
  });

  it('starts the interpreter with its own temp directory and no display', () => {
    const env = scriptEnvironment('/runs/r/home');
    expect(env.TMPDIR).toBe('/runs/r/home/tmp');
    expect(env.PYTHONDONTWRITEBYTECODE).toBe('1');
    expect(env.MPLBACKEND).toBe('Agg');
  });
});

describe('a run', () => {
  it('finds the interpreter this machine has, or none (the suite below is skipped then)', () => {
    if (!PYTHON_AVAILABLE)
      console.warn('no python3 on this machine: the script runner suite is skipped');
    expect(python !== null).toBe(PYTHON_AVAILABLE);
  });

  itWithPython(
    'copies the chosen files in by name, stages what the script writes, and cleans up',
    async () => {
      const outcome = await runner.run(TARGET, {
        code: [
          'import csv, os',
          'print(sorted(os.listdir("in")))',
          'rows = list(csv.DictReader(open("in/report.csv")))',
          'ok = {r["mrn"]: r["text_ok"] for r in csv.DictReader(open("in/report (2).csv"))}',
          'with open("out/matched.csv", "w", newline="") as f:',
          '    w = csv.writer(f); w.writerow(["mrn", "name", "phone", "text_ok"])',
          '    for r in rows: w.writerow([r["mrn"], r["name"], r["phone"], ok.get(r["mrn"], "")])',
          'print("matched", len(rows))',
        ].join('\n'),
        fileIds: [REPORT_ID, LOOKUP_ID],
        timeoutMs: 30_000,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain("['report (2).csv', 'report.csv']");
      expect(outcome.stdout).toContain('matched 2');
      expect(outcome.inputs.map((input) => input.path)).toEqual([
        'in/report.csv',
        'in/report (2).csv',
      ]);
      expect(outcome.outputs).toHaveLength(1);
      expect(outcome.outputs[0]).toMatchObject({
        filename: 'matched.csv',
        source: 'script',
        contentType: 'text/csv',
      });
      expect(store.insertFile).toHaveBeenCalledTimes(1);
      expect(outcome.skippedOutputs).toEqual([]);
      expect(outcome.uidIsolated).toBe(canIsolateByUid());
      expect(outcome.networkIsolated).toBe(networkIsolated);
      // The staged bytes are the file the script wrote.
      const storageKey = (store.insertFile.mock.calls[0]![1] as { storageKey: string }).storageKey;
      const bytes = await disk.readFile(storageKey);
      expect(bytes?.toString('utf8')).toContain('1002,Grace,,N');
      // Nothing of the run is left behind.
      expect(await readdir(runsRoot)).toEqual([]);
    }
  );

  itWithPython(
    'hands over every staged file when none are chosen, and cannot rewrite the staged copy',
    async () => {
      const outcome = await runner.run(TARGET, {
        code: [
          'import os',
          'print(len(os.listdir("in")))',
          'try:',
          '    open("in/report.csv", "w").write("x"); print("rewrote")',
          'except OSError as e:',
          '    print("read-only:", type(e).__name__)',
        ].join('\n'),
        fileIds: null,
        timeoutMs: 30_000,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('2\n');
      // Root may write to a read-only file; a dropped uid may not.
      if (canIsolateByUid()) expect(outcome.stdout).toContain('read-only: PermissionError');
      const original = await disk.readFile(staged.get(REPORT_ID)!.storageKey);
      expect(original?.toString('utf8')).toContain('1001,Ada');
    }
  );

  itWithPython('skips what cannot be staged from out/, naming why', async () => {
    store.countFiles.mockResolvedValue(0);
    const outcome = await runner.run(TARGET, {
      code: [
        'import os',
        'os.mkdir("out/folder")',
        'open("out/.hidden", "w").write("x")',
        'open("out/empty.txt", "w").close()',
        'open("out/kept.json", "w").write("{}")',
        'os.symlink("/etc/hostname", "out/link.txt")',
        'open("out/big.bin", "wb").write(b"0" * (1_048_576 + 1))',
      ].join('\n'),
      fileIds: [],
      timeoutMs: 30_000,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.outputs.map((file) => file.filename)).toEqual(['kept.json']);
    expect(outcome.skippedOutputs).toEqual(
      expect.arrayContaining([
        { filename: '.hidden', reason: expect.stringContaining('not a name') },
        { filename: 'big.bin', reason: expect.stringContaining('over the') },
        { filename: 'empty.txt', reason: 'empty' },
        { filename: 'folder', reason: expect.stringContaining('directory') },
        { filename: 'link.txt', reason: 'not a regular file' },
      ])
    );
  });

  itWithPython('refuses a file that is not the caller’s before anything runs', async () => {
    await expect(
      runner.run(OTHER, { code: 'print(1)', fileIds: [REPORT_ID], timeoutMs: 30_000 })
    ).rejects.toMatchObject({ refusal: { type: 'not_found' } });
    expect(await readdir(runsRoot)).toEqual([]);
  });

  itWithPython('kills a run at its wall clock and says so', async () => {
    const outcome = await runner.run(TARGET, {
      code: 'import time\nprint("started", flush=True)\ntime.sleep(30)\nprint("never")',
      fileIds: [],
      timeoutMs: 1_500,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.stdout).toContain('started');
    expect(outcome.stdout).not.toContain('never');
    expect(await readdir(runsRoot)).toEqual([]);
  });

  itWithPython('holds a run to its memory ceiling', async () => {
    const outcome = await runner.run(TARGET, {
      code: 'b = bytearray(1024 * 1024 * 1024)\nprint("allocated a gigabyte")',
      fileIds: [],
      timeoutMs: 30_000,
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stdout).not.toContain('allocated');
    expect(outcome.stderr).toContain('MemoryError');
  });

  itWithPython('runs one script per caller at a time', async () => {
    const first = runner.run(TARGET, {
      code: 'import time\ntime.sleep(2)',
      fileIds: [],
      timeoutMs: 30_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(
      runner.run(TARGET, { code: 'print(1)', fileIds: [], timeoutMs: 30_000 })
    ).rejects.toBeInstanceOf(ScriptRunError);
    expect((await first).exitCode).toBe(0);
  });

  itWithPython(
    'starts a script with no network and no reach into the staged-file disk, when root',
    async () => {
      if (!canIsolateByUid()) return;
      const outcome = await runner.run(TARGET, {
        code: [
          NETWORK_PROBE,
          'try:',
          `    os.listdir(${JSON.stringify(disk.getDataRoot())}); print("data readable")`,
          'except PermissionError:',
          '    print("data blocked")',
        ].join('\n'),
        fileIds: [],
        timeoutMs: 30_000,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).not.toContain('uid 0');
      expect(outcome.stdout).toContain('data blocked');
      expect(outcome.networkIsolated).toBe(networkIsolated);
      if (networkIsolated) expect(outcome.stdout).toContain('net blocked');
    }
  );

  itWithPython(
    'blocks the network in every isolation mode this machine supports, and the script still sees its own uid',
    async () => {
      const identity = canIsolateByUid() ? { uid: 65_534, gid: 65_534 } : null;
      for (const mode of NETWORK_ISOLATION_MODES) {
        if (mode === 'netns' && !identity) continue; // needs root; never chosen without it
        const works = (await probeNetworkIsolation(mode, identity)) === null;
        const outcome = await runnerIn(mode).run(TARGET, {
          code: NETWORK_PROBE,
          fileIds: [],
          timeoutMs: 30_000,
        });
        if (!works) {
          // The kernel or seccomp said no: the run fails plainly rather than running with a network.
          expect(outcome.exitCode).not.toBe(0);
          continue;
        }
        expect(outcome.exitCode).toBe(0);
        expect(outcome.networkIsolated).toBe(true);
        expect(outcome.stdout).toContain('net blocked');
        if (canIsolateByUid()) expect(outcome.stdout).not.toContain('uid 0');
      }
    }
  );

  itWithPython(
    'reports a run on the container’s network as such (the operator opt-in path)',
    async () => {
      const outcome = await runnerIn(null).run(TARGET, {
        code: 'print("ran")',
        fileIds: [],
        timeoutMs: 30_000,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.networkIsolated).toBe(false);
    }
  );
});
