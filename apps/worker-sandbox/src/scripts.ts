/**
 * Scripts over staged files — the I/O half behind `sandbox_run_python`
 * (the pure half is @renkei/connector-sandbox's scripts.ts; the HTTP
 * verb is script-endpoints.ts).
 *
 * A run is a throwaway directory under SANDBOX_RUNS_DIR (default /runs):
 *
 *   <root>/<uuid>/            the run, mode 0700, the caller's uid
 *   <root>/<uuid>/main.py     the script, read-only
 *   <root>/<uuid>/in/         copies of the staged files it asked for, read-only
 *   <root>/<uuid>/out/        where it writes; staged back when it exits
 *   <root>/<uuid>/home/       its HOME and TMPDIR, so nothing lands in a shared /tmp
 *
 * made for the run and removed when it ends, however it ends. Staged
 * files are this process's alone on disk (the data root is root's), so
 * the inputs are COPIED in, owned by the caller's uid, rather than the
 * script being pointed at them; and what it writes comes back through
 * the same quota, cap and TTL every other staged file is held to
 * (staging.ts) — a script cannot stage more than a person could.
 *
 * WHO runs it is workspaces.ts's arrangement, narrowed further: the
 * caller's own unprivileged uid with no groups, caps or new privileges;
 * an environment built from nothing (no secrets, no variables of this
 * process); a process ceiling, an address-space ceiling and a file-size
 * ceiling; a wall clock that kills the whole process group; and — the
 * gap a workspace command has to leave open and a script over a
 * person's data does not — NO NETWORK: the interpreter starts in its own
 * empty network namespace when the kernel lets this worker make one,
 * and the result says plainly when it did not. The interpreter runs in
 * isolated mode (-I: no PYTHON* variables, no user site, no script
 * directory on the path) with bytecode writing off, so what runs is the
 * script and the image's own libraries, nothing it finds beside itself.
 */

import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  chown,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  EXEC_MAX_FILE_BYTES,
  SCRIPT_INPUT_DIR,
  SCRIPT_MAIN_FILE,
  SCRIPT_MAX_CONCURRENT_RUNS,
  SCRIPT_MAX_INPUT_BYTES,
  SCRIPT_MAX_INPUT_FILES,
  SCRIPT_MAX_MEMORY_BYTES,
  SCRIPT_MAX_OUTPUT_FILES,
  SCRIPT_MAX_PROCESSES,
  SCRIPT_OUTPUT_DIR,
  inputNamesFor,
  outputMediaType,
  validateOutputName,
  type SandboxFileSummary,
} from '@renkei/connector-sandbox';
import * as disk from './disk';
import * as store from './store';
import { stageBytes } from './staging';
import { identityFor, runProcess, type ExecIdentity, type RunResult } from './workspaces';
import { logger } from './logger';

/** Where the image keeps the interpreter with the data libraries (docker/Dockerfile, target sandbox). */
export const DEFAULT_PYTHON = '/opt/sandbox-python/bin/python3';

export interface ScriptRunnerDeps {
  db: Kysely<DB>;
  /** The directory runs are made under; its own, apart from the data and workspaces roots. */
  runsRoot: string;
  /** The interpreter's path (resolvePython). */
  python: string;
  /** Whether a run starts with no network (verifyNetworkIsolation said yes at boot). */
  isolateNetwork: boolean;
  /** RLIMIT_AS for a run, in bytes. */
  memoryBytes: number;
  /** The per-tenant per-file ceiling for what a run stages back. */
  maxFileBytes: (tenantId: string) => Promise<number>;
}

export interface ScriptRunInput {
  code: string;
  /** Staged file ids to copy in; null means every file the caller has staged. */
  fileIds: string[] | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ScriptInputSummary {
  id: string;
  filename: string;
  /** The path the script saw it at, relative to its working directory. */
  path: string;
  sizeBytes: number;
}

export interface SkippedOutput {
  filename: string;
  reason: string;
}

export interface ScriptRunOutcome extends RunResult {
  timeoutMs: number;
  inputs: ScriptInputSummary[];
  outputs: SandboxFileSummary[];
  skippedOutputs: SkippedOutput[];
  /** Whether the run had no network; false on a worker that cannot unshare. */
  networkIsolated: boolean;
  /** Whether the run was dropped to the caller's own uid; false on an unprivileged worker. */
  uidIsolated: boolean;
}

export type ScriptRunRefusal =
  | { type: 'not_found'; message: string }
  | { type: 'too_large'; message: string }
  | { type: 'busy'; message: string };

export class ScriptRunError extends Error {
  constructor(public readonly refusal: ScriptRunRefusal) {
    super(refusal.message);
    this.name = 'ScriptRunError';
  }
}

/**
 * The interpreter a run gets: SANDBOX_PYTHON when set, else the image's
 * own environment when it is there, else whatever `python3` the PATH
 * finds (a developer's machine). Null when none is executable.
 */
export async function resolvePython(configured: string | undefined): Promise<string | null> {
  const candidates = [configured?.trim(), DEFAULT_PYTHON, 'python3'].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  for (const candidate of candidates) {
    if (!candidate.includes('/')) return candidate;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // The next one.
    }
  }
  return null;
}

/** What `python3 --version` and the data libraries say, for the boot log and the tool's description. */
export async function probePython(
  python: string
): Promise<{ version: string; libraries: string[] } | null> {
  const probe = await runProcess(
    { cwd: '/', home: '/', identity: null, env: {}, timeoutMs: 30_000 },
    python,
    [
      '-I',
      '-c',
      'import sys, importlib\n' +
        'print(sys.version.split()[0])\n' +
        'for name in ("pandas", "numpy", "openpyxl", "xlsxwriter", "dateutil"):\n' +
        '    try:\n' +
        '        module = importlib.import_module(name)\n' +
        '        print(name, getattr(module, "__version__", ""))\n' +
        '    except Exception:\n' +
        '        pass\n',
    ]
  );
  if (probe.exitCode !== 0) return null;
  const [version = '', ...rest] = probe.stdout.trim().split('\n');
  return { version, libraries: rest.map((line) => line.trim()).filter(Boolean) };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The prelude a script runs behind: its process, file-size and
 * address-space ceilings (per uid, so a fork bomb or an allocation loop
 * stops at the caller's own), no core dumps, then the interpreter in
 * isolated mode. `exec`, so the limits apply to the interpreter itself,
 * not a shell around it.
 */
export function scriptCommand(python: string, memoryBytes: number): string {
  const fileKb = Math.floor(EXEC_MAX_FILE_BYTES / 1024);
  const memoryKb = Math.floor(memoryBytes / 1024);
  return (
    `ulimit -u ${SCRIPT_MAX_PROCESSES} -f ${fileKb} -v ${memoryKb} -c 0 2>/dev/null\n` +
    `exec ${shellQuote(python)} -I -B ${SCRIPT_MAIN_FILE}`
  );
}

/** The environment a script starts with: Python's own switches and nothing of this process. */
export function scriptEnvironment(home: string): Record<string, string> {
  return {
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
    // A plotting library imported out of habit must not look for a display.
    MPLBACKEND: 'Agg',
    // Temporary files under the run's own HOME, never a shared /tmp.
    TMPDIR: join(home, 'tmp'),
    // Numeric libraries default to every core; a run shares the container.
    OMP_NUM_THREADS: '2',
    OPENBLAS_NUM_THREADS: '2',
    MKL_NUM_THREADS: '2',
  };
}

function targetKey(target: store.SandboxTarget): string {
  return `${target.tenantId}\n${target.subject}`;
}

/**
 * Remove a run directory however the run left it. `in/` is made
 * read-only for the script (0500), and a script may leave read-only
 * directories of its own under `out/` or `home/`; root removes those
 * regardless, but an unprivileged worker (a developer's checkout, CI)
 * cannot unlink from a directory it may not write to. So every
 * directory is reopened on the way down first — they are this
 * process's own, or the caller's uid's which root may chmod — and only
 * then removed.
 */
export async function removeRunDir(dir: string): Promise<void> {
  await reopenDirectories(dir);
  await rm(dir, { recursive: true, force: true });
}

async function reopenDirectories(dir: string): Promise<void> {
  let entries;
  try {
    await chmod(dir, 0o700);
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Already gone, or not ours to open: rm says so if it matters.
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await reopenDirectories(join(dir, entry.name));
    }
  }
}

async function chownIf(path: string, identity: ExecIdentity | null): Promise<void> {
  if (identity) await chown(path, identity.uid, identity.gid);
}

export class ScriptRunner {
  private readonly busy = new Set<string>();
  private inFlight = 0;

  constructor(private readonly deps: ScriptRunnerDeps) {}

  /** Runs in flight on this worker right now. */
  get running(): number {
    return this.inFlight;
  }

  /**
   * The runs root, traversable by everyone and listable by nobody but
   * root (0711 under the worker's 0077 umask, so set again with chmod —
   * workspaces.ts explains the umask hazard), with whatever a previous
   * process left behind removed: a run that died with the worker is
   * nobody's to resume.
   */
  async prepare(): Promise<number> {
    await mkdir(this.deps.runsRoot, { recursive: true, mode: 0o711 });
    await chmod(this.deps.runsRoot, 0o711);
    let removed = 0;
    for (const entry of await readdir(this.deps.runsRoot)) {
      await removeRunDir(join(this.deps.runsRoot, entry));
      removed += 1;
    }
    return removed;
  }

  async run(target: store.SandboxTarget, input: ScriptRunInput): Promise<ScriptRunOutcome> {
    const key = targetKey(target);
    if (this.busy.has(key)) {
      throw new ScriptRunError({
        type: 'busy',
        message: 'A script of yours is already running; wait for it to finish.',
      });
    }
    if (this.inFlight >= SCRIPT_MAX_CONCURRENT_RUNS) {
      throw new ScriptRunError({
        type: 'busy',
        message: 'The sandbox is running as many scripts as it can right now; try again shortly.',
      });
    }
    this.busy.add(key);
    this.inFlight += 1;
    const runDir = join(this.deps.runsRoot, randomUUID());
    try {
      return await this.runIn(runDir, target, input);
    } finally {
      this.busy.delete(key);
      this.inFlight -= 1;
      await removeRunDir(runDir).catch((error: unknown) => {
        logger.warn('could not remove run directory {dir}: {error}', {
          component: 'worker-sandbox/scripts',
          dir: runDir,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async resolveInputs(
    target: store.SandboxTarget,
    fileIds: string[] | null
  ): Promise<store.StoredFile[]> {
    const ids =
      fileIds ??
      (await store.listFiles(this.deps.db, target))
        .slice(0, SCRIPT_MAX_INPUT_FILES)
        .map((file) => file.id);
    const files: store.StoredFile[] = [];
    for (const id of ids) {
      const file = await store.getFile(this.deps.db, target, id);
      if (!file) {
        throw new ScriptRunError({
          type: 'not_found',
          message: `No staged file ${id} — sandbox_list_files shows what you have.`,
        });
      }
      files.push(file);
    }
    return files;
  }

  private async runIn(
    runDir: string,
    target: store.SandboxTarget,
    input: ScriptRunInput
  ): Promise<ScriptRunOutcome> {
    const identity = identityFor(target);
    const files = await this.resolveInputs(target, input.fileIds);

    const inDir = join(runDir, SCRIPT_INPUT_DIR);
    const outDir = join(runDir, SCRIPT_OUTPUT_DIR);
    const home = join(runDir, 'home');
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    for (const dir of [inDir, outDir, home, join(home, 'tmp')]) {
      await mkdir(dir, { mode: 0o700 });
    }

    // The inputs, copied in under the caller's uid and made read-only —
    // a script that rewrites `in/report.xlsx` has changed its copy, not
    // the staged file. Their total is bounded before the copy of the file
    // that would cross it finishes.
    const names = inputNamesFor(files);
    const inputs: ScriptInputSummary[] = [];
    let inputBytes = 0;
    for (const file of files) {
      const name = names.get(file.id)!;
      const destination = join(inDir, name);
      const copied = await disk.copyFileTo(file.storageKey, destination);
      if (!copied) {
        throw new ScriptRunError({
          type: 'not_found',
          message: `The bytes of "${file.filename}" are not on this worker's disk.`,
        });
      }
      const size = (await stat(destination)).size;
      inputBytes += size;
      if (inputBytes > SCRIPT_MAX_INPUT_BYTES) {
        throw new ScriptRunError({
          type: 'too_large',
          message: `A run takes at most ${SCRIPT_MAX_INPUT_BYTES} bytes of input across its files.`,
        });
      }
      await chmod(destination, 0o400);
      await chownIf(destination, identity);
      inputs.push({
        id: file.id,
        filename: file.filename,
        path: `${SCRIPT_INPUT_DIR}/${name}`,
        sizeBytes: size,
      });
    }
    await writeFile(join(runDir, SCRIPT_MAIN_FILE), input.code, { mode: 0o400 });

    // Ownership last, leaves first: the caller's uid must own every
    // directory it writes to and be able to read every file, and the
    // input directory itself is read-only to it once the copies are in.
    for (const path of [join(home, 'tmp'), home, outDir, join(runDir, SCRIPT_MAIN_FILE)]) {
      await chownIf(path, identity);
    }
    await chownIf(inDir, identity);
    await chmod(inDir, 0o500);
    await chownIf(runDir, identity);

    const isolateNetwork = this.deps.isolateNetwork && identity !== null;
    const result = await runProcess(
      {
        cwd: runDir,
        home,
        identity,
        env: scriptEnvironment(home),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        isolateNetwork,
      },
      'bash',
      ['-c', scriptCommand(this.deps.python, this.deps.memoryBytes)]
    );

    const staged = await this.stageOutputs(target, outDir);
    return {
      ...result,
      timeoutMs: input.timeoutMs,
      inputs,
      outputs: staged.outputs,
      skippedOutputs: staged.skipped,
      networkIsolated: isolateNetwork,
      uidIsolated: identity !== null,
    };
  }

  /**
   * What the script left in `out/`, staged back: regular files only (a
   * symlink out of the run directory is not followed, a directory is not
   * descended), with a name a staged file may carry, up to the count
   * ceiling, each under the caller's quota and cap. What is not staged
   * is named with why, so the model can say so rather than guess.
   */
  private async stageOutputs(
    target: store.SandboxTarget,
    outDir: string
  ): Promise<{ outputs: SandboxFileSummary[]; skipped: SkippedOutput[] }> {
    const outputs: SandboxFileSummary[] = [];
    const skipped: SkippedOutput[] = [];
    const entries = (await readdir(outDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const tenantCap = await this.deps.maxFileBytes(target.tenantId);
    for (const entry of entries) {
      if (outputs.length >= SCRIPT_MAX_OUTPUT_FILES) {
        skipped.push({
          filename: entry.name,
          reason: `a run stages at most ${SCRIPT_MAX_OUTPUT_FILES} files`,
        });
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({
          filename: entry.name,
          reason: entry.isDirectory()
            ? 'a directory; write files directly under out/'
            : 'not a regular file',
        });
        continue;
      }
      const named = validateOutputName(entry.name);
      if (!named.ok) {
        skipped.push({ filename: entry.name, reason: 'not a name a staged file may carry' });
        continue;
      }
      const path = join(outDir, entry.name);
      const size = (await stat(path)).size;
      if (size === 0) {
        skipped.push({ filename: entry.name, reason: 'empty' });
        continue;
      }
      const result = await stageBytes(
        this.deps.db,
        target,
        {
          filename: named.filename,
          contentType: outputMediaType(named.filename),
          source: 'script',
          sizeBytes: size,
        },
        () => readFile(path),
        tenantCap
      );
      if (result.ok) {
        outputs.push(result.file);
        continue;
      }
      skipped.push({
        filename: entry.name,
        reason:
          result.reason === 'too_large'
            ? `${size} bytes, over the ${result.cap}-byte limit for a staged file`
            : result.reason === 'quota_full'
              ? 'the scratch space quota is full — delete some staged files first'
              : 'too many files staged — delete some first',
      });
    }
    return { outputs, skipped };
  }
}

/** The memory ceiling for a run from SANDBOX_SCRIPT_MEMORY, else the default. */
export function scriptMemoryBytes(raw: string | undefined): number {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return SCRIPT_MAX_MEMORY_BYTES;
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/.exec(value);
  if (!match) throw new Error(`SANDBOX_SCRIPT_MEMORY is not a memory size: ${raw}`);
  const scale = { '': 1, k: 1_024, m: 1_048_576, g: 1_073_741_824 }[match[2]!] ?? 1;
  const bytes = Math.floor(Number(match[1]) * scale);
  if (bytes < 64 * 1_048_576)
    throw new Error(`SANDBOX_SCRIPT_MEMORY is too small to run Python: ${raw}`);
  return bytes;
}
