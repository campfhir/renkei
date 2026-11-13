/**
 * Notebook kernels — one long-lived Python per (caller, checkout,
 * notebook), so the code pane can run a notebook a cell at a time and
 * each cell sees what the ones before it defined. Started the way every
 * other process in a checkout is (the caller's own uid, an environment
 * built from nothing plus the caller's own variables, behind the shell
 * prelude's limits), in the notebook's own folder; what it runs and how
 * it is spoken to is kernel-host.ts.
 *
 * A kernel is found by its notebook's path, not by an id the page must
 * keep: `execute` starts one when there is none (a first run, a worker
 * restarted, an idle kernel reaped) and says so (`started`), which is
 * how the page learns that earlier cells' state is gone. Cells run one
 * at a time in the order asked. A cell that outlives its time limit is
 * interrupted, not killed — the kernel and its state stay; a kernel
 * that will not come back from an interrupt is ended. Kernels with
 * nothing run for KERNEL_IDLE_MS are ended, as are all of them when
 * this process exits.
 *
 * A kernel belongs to the caller who started it: another caller's
 * notebook of the same path in the same checkout is another kernel.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { actorAttrs } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { logger } from './logger';
import { KERNEL_HOST_SOURCE, KERNEL_LAUNCH } from './kernel-host';
import {
  childEnvironment,
  shellPrelude,
  wrapCommand,
  type ExecIdentity,
  type RunInput,
} from './workspaces';

const COMPONENT = 'worker-sandbox/kernels';
const REAP_INTERVAL_MS = 60_000;
/** How long a kernel may take to say it is ready: a first start makes its environment. */
export const KERNEL_START_TIMEOUT_MS = 120_000;
/** A kernel nothing has run in for this long is ended. */
export const KERNEL_IDLE_MS = 30 * 60_000;
export const KERNEL_MAX_PER_WORKSPACE = 4;
export const KERNEL_MAX = 32;
/** How long one cell may run before it is interrupted. */
export const KERNEL_EXECUTE_DEFAULT_MS = 10 * 60_000;
export const KERNEL_EXECUTE_MAX_MS = 30 * 60_000;
/** After an interrupt, how long the cell has to stop before the kernel is ended. */
const INTERRUPT_GRACE_MS = 10_000;
const SHUTDOWN_GRACE_MS = 3_000;

export interface KernelOwner {
  subject: string;
}

export interface KernelInput {
  owner: KernelOwner;
  workspaceId: string;
  /** The checkout's directory on disk. */
  rootDir: string;
  home: string;
  identity: ExecIdentity | null;
  /** The notebook, relative to the checkout (already validated). */
  path: string;
  /** The caller's own variables, as a command in the checkout gets them. */
  env: Record<string, string>;
  /** The worker's packaged Python, offered to a new notebook environment. */
  sandboxPython?: string | null;
}

export interface KernelView {
  engine: 'kernel' | 'builtin';
  /** The Python's version ("3.11.2"). */
  python: string;
}

export type KernelFailure = { ok: false; status: number; type: string; message: string };

export type ExecuteOutcome =
  | {
      ok: true;
      kernel: KernelView;
      /** This call started the kernel: nothing earlier cells defined is there. */
      started: boolean;
      /**
       * When this call started the kernel: what this worker knows became of
       * the notebook's last one — reaped for idleness, or ended (it exited,
       * crashed or was closed). Null when this worker never had one, which
       * with `workerUptimeMs` tells a restart from another replica.
       */
      previous: 'idle' | 'ended' | null;
      /** How long this worker process has been up. */
      workerUptimeMs: number;
      /** nbformat outputs, as the notebook stores them. */
      outputs: unknown[];
      executionCount: number | null;
      /** The cell ran without raising. */
      succeeded: boolean;
      /** The cell was interrupted by its time limit. */
      timedOut: boolean;
    }
  | KernelFailure;

interface Kernel {
  key: string;
  owner: KernelOwner;
  workspaceId: string;
  path: string;
  child: ChildProcess;
  state: 'starting' | 'ready' | 'exited';
  view: KernelView;
  ready: Promise<KernelFailure | null>;
  lastActivity: number;
  /** The cell in flight, by request id. */
  pending: Map<string, (answer: Record<string, unknown> | null) => void>;
  /** Cells wait their turn on this. */
  tail: Promise<unknown>;
  busy: number;
  nextId: number;
  stderrTail: string;
}

export interface KernelSessionsDeps {
  /** Test-only: a different spawn (a scripted host). */
  spawnKernel?: (input: KernelInput) => ChildProcess;
  /** Test-only: shorter waits. */
  startTimeoutMs?: number;
  interruptGraceMs?: number;
}

function keyOf(input: { owner: KernelOwner; workspaceId: string; path: string }): string {
  return `${input.owner.subject}\n${input.workspaceId}\n${input.path}`;
}

/** How many ended kernels are remembered, to say why a notebook's last one is gone. */
const ENDED_MEMORY = 1_000;

export class KernelSessions {
  private readonly kernels = new Map<string, Kernel>();
  /** What became of each notebook's last kernel here, until its next one starts. */
  private readonly ended = new Map<string, 'idle' | 'ended'>();
  private readonly bootedAt = Date.now();
  private readonly reaper: NodeJS.Timeout;

  constructor(private readonly deps: KernelSessionsDeps = {}) {
    this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  count(): number {
    return this.kernels.size;
  }

  /** The notebook's kernel, when it has a live one. */
  status(input: { owner: KernelOwner; workspaceId: string; path: string }): KernelView | null {
    const kernel = this.kernels.get(keyOf(input));
    return kernel && kernel.state === 'ready' ? kernel.view : null;
  }

  /** The notebook's kernel, started if it has none. */
  private async ensure(
    input: KernelInput
  ): Promise<
    | { ok: true; kernel: Kernel; started: boolean; previous: 'idle' | 'ended' | null }
    | KernelFailure
  > {
    const key = keyOf(input);
    const existing = this.kernels.get(key);
    if (existing && existing.state !== 'exited') {
      const failure = await existing.ready;
      if (failure) return failure;
      return { ok: true, kernel: existing, started: false, previous: null };
    }
    const inWorkspace = [...this.kernels.values()].filter(
      (kernel) => kernel.workspaceId === input.workspaceId
    ).length;
    if (inWorkspace >= KERNEL_MAX_PER_WORKSPACE) {
      return {
        ok: false,
        status: 429,
        type: 'kernel_limit',
        message: `At most ${KERNEL_MAX_PER_WORKSPACE} notebooks run in one checkout at once; stop another notebook's kernel first.`,
      };
    }
    if (this.kernels.size >= KERNEL_MAX) {
      return {
        ok: false,
        status: 429,
        type: 'kernel_limit',
        message: 'This worker is running as many notebook kernels as it will; try again shortly.',
      };
    }
    let child: ChildProcess;
    try {
      child = this.deps.spawnKernel ? this.deps.spawnKernel(input) : spawnKernel(input);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        type: 'spawn_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const previous = this.ended.get(key) ?? null;
    this.ended.delete(key);
    let settle: (failure: KernelFailure | null) => void = () => {};
    const kernel: Kernel = {
      key,
      owner: input.owner,
      workspaceId: input.workspaceId,
      path: input.path,
      child,
      state: 'starting',
      view: { engine: 'builtin', python: '' },
      ready: new Promise<KernelFailure | null>((resolve) => {
        settle = resolve;
      }),
      lastActivity: Date.now(),
      pending: new Map(),
      tail: Promise.resolve(),
      busy: 0,
      nextId: 1,
      stderrTail: '',
    };
    this.kernels.set(key, kernel);

    const startTimer = setTimeout(() => {
      if (kernel.state !== 'starting') return;
      settle({
        ok: false,
        status: 504,
        type: 'kernel_start_timeout',
        message: 'The notebook kernel took too long to start.',
      });
      this.end(kernel);
    }, this.deps.startTimeoutMs ?? KERNEL_START_TIMEOUT_MS);
    startTimer.unref();

    child.stderr?.on('data', (chunk: Buffer) => {
      kernel.stderrTail = (kernel.stderrTail + chunk.toString('utf8')).slice(-2_000);
    });
    child.stdin?.on('error', () => {
      // The process went away mid-write; its exit says the rest.
    });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message)) return;
        if (kernel.state === 'starting' && 'ready' in message) {
          clearTimeout(startTimer);
          if (message.ready === true) {
            kernel.state = 'ready';
            kernel.view = {
              engine: message.engine === 'kernel' ? 'kernel' : 'builtin',
              python: typeof message.python === 'string' ? message.python : '',
            };
            settle(null);
          } else {
            settle({
              ok: false,
              status: 422,
              type: 'no_python',
              message: 'There is no Python in the sandbox to run the notebook with.',
            });
          }
          return;
        }
        if (typeof message.id === 'string') {
          const resolve = kernel.pending.get(message.id);
          kernel.pending.delete(message.id);
          resolve?.(message);
        }
      });
    }
    const gone = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (kernel.state === 'exited') return;
      const starting = kernel.state === 'starting';
      kernel.state = 'exited';
      clearTimeout(startTimer);
      if (this.kernels.get(key) === kernel) this.kernels.delete(key);
      // A kernel that had run is remembered as gone, unless the reaper said why already.
      if (!starting && !this.ended.has(key)) this.remember(key, 'ended');
      if (starting) {
        settle({
          ok: false,
          status: 500,
          type: 'kernel_failed',
          message: `The notebook kernel did not start${kernel.stderrTail.trim() ? `: ${kernel.stderrTail.trim().split('\n').slice(-3).join('\n')}` : '.'}`,
        });
      }
      for (const resolve of kernel.pending.values()) resolve(null);
      kernel.pending.clear();
      void actorAttrs(kernel.owner.subject).then((who) => {
        logger.info('the kernel of the notebook {path} of {actor} ended ({how})', {
          component: COMPONENT,
          ...who,
          workspaceId: kernel.workspaceId,
          path: kernel.path,
          how: signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`,
        });
      });
    };
    child.on('exit', gone);
    child.on('error', (error) => {
      kernel.stderrTail = `${kernel.stderrTail}\n${error.message}`.slice(-2_000);
      gone(null, null);
    });

    const failure = await kernel.ready;
    if (failure) {
      this.end(kernel);
      return failure;
    }
    return { ok: true, kernel, started: true, previous };
  }

  private remember(key: string, how: 'idle' | 'ended'): void {
    this.ended.delete(key);
    this.ended.set(key, how);
    // Oldest first out: this is a courtesy to the next run, not a record.
    while (this.ended.size > ENDED_MEMORY) {
      const oldest = this.ended.keys().next();
      if (oldest.done) break;
      this.ended.delete(oldest.value);
    }
  }

  /** Run one cell in the notebook's kernel, starting the kernel when it has none. */
  async execute(input: KernelInput, code: string, timeoutMs: number): Promise<ExecuteOutcome> {
    const ensured = await this.ensure(input);
    if (!ensured.ok) return ensured;
    const { kernel, started, previous } = ensured;
    kernel.busy += 1;
    kernel.lastActivity = Date.now();
    const turn = kernel.tail.then(() => this.runCell(kernel, code, timeoutMs));
    kernel.tail = turn.catch(() => undefined);
    try {
      const answer = await turn;
      if (!answer.ok) return answer;
      return {
        ...answer,
        kernel: kernel.view,
        started,
        previous,
        workerUptimeMs: Date.now() - this.bootedAt,
      };
    } finally {
      kernel.busy -= 1;
      kernel.lastActivity = Date.now();
    }
  }

  private async runCell(
    kernel: Kernel,
    code: string,
    timeoutMs: number
  ): Promise<
    | {
        ok: true;
        outputs: unknown[];
        executionCount: number | null;
        succeeded: boolean;
        timedOut: boolean;
      }
    | KernelFailure
  > {
    if (kernel.state !== 'ready') return died(kernel);
    const id = String(kernel.nextId++);
    let timedOut = false;
    const answered = new Promise<Record<string, unknown> | null>((resolve) => {
      kernel.pending.set(id, resolve);
    });
    const limit = setTimeout(() => {
      // Past its time: stop the cell and keep the kernel — unless the
      // cell ignores the interrupt, in which case the kernel goes.
      timedOut = true;
      this.signal(kernel, 'SIGINT');
      setTimeout(() => {
        if (kernel.pending.has(id)) this.end(kernel);
      }, this.deps.interruptGraceMs ?? INTERRUPT_GRACE_MS).unref();
    }, timeoutMs);
    try {
      kernel.child.stdin?.write(`${JSON.stringify({ id, code })}\n`);
    } catch {
      // Gone already; the exit handler answers `null`.
    }
    const message = await answered;
    clearTimeout(limit);
    if (!message) return died(kernel);
    return {
      ok: true,
      outputs: Array.isArray(message.outputs) ? message.outputs : [],
      executionCount: typeof message.execution_count === 'number' ? message.execution_count : null,
      succeeded: message.ok === true,
      timedOut,
    };
  }

  /** Interrupt the running cell; the kernel and what it holds stay. False when there is no kernel. */
  interrupt(input: { owner: KernelOwner; workspaceId: string; path: string }): boolean {
    const kernel = this.kernels.get(keyOf(input));
    if (!kernel || kernel.state !== 'ready') return false;
    if (kernel.busy > 0) this.signal(kernel, 'SIGINT');
    return true;
  }

  /** End the notebook's kernel and everything it holds. False when there was none. */
  close(input: { owner: KernelOwner; workspaceId: string; path: string }): boolean {
    const kernel = this.kernels.get(keyOf(input));
    if (!kernel) return false;
    this.end(kernel);
    return true;
  }

  /** Every kernel of a checkout that is going away. */
  closeWorkspace(workspaceId: string): void {
    for (const kernel of [...this.kernels.values()]) {
      if (kernel.workspaceId === workspaceId) this.end(kernel);
    }
  }

  private signal(kernel: Kernel, signal: NodeJS.Signals): void {
    const pid = kernel.child.pid;
    if (pid === undefined) return;
    try {
      // The group: a cell's own child processes (a `!command`) with it.
      process.kill(-pid, signal);
    } catch {
      try {
        kernel.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private end(kernel: Kernel): void {
    if (this.kernels.get(kernel.key) === kernel) this.kernels.delete(kernel.key);
    if (kernel.state === 'exited') return;
    try {
      kernel.child.stdin?.end();
    } catch {
      // Closed already.
    }
    this.signal(kernel, 'SIGTERM');
    setTimeout(() => {
      if (kernel.state !== 'exited') this.signal(kernel, 'SIGKILL');
    }, SHUTDOWN_GRACE_MS).unref();
  }

  /** Kernels nothing has run in for KERNEL_IDLE_MS are ended. */
  reapIdle(now = Date.now()): number {
    let reaped = 0;
    for (const kernel of [...this.kernels.values()]) {
      if (kernel.busy === 0 && now - kernel.lastActivity > KERNEL_IDLE_MS) {
        if (kernel.state === 'ready') this.remember(kernel.key, 'idle');
        this.end(kernel);
        reaped += 1;
      }
    }
    return reaped;
  }

  /** Every kernel, on the way out. */
  closeAll(): void {
    clearInterval(this.reaper);
    for (const kernel of [...this.kernels.values()]) this.end(kernel);
  }
}

function died(kernel: Kernel): KernelFailure {
  const tail = kernel.stderrTail.trim().split('\n').slice(-3).join('\n');
  return {
    ok: false,
    status: 410,
    type: 'kernel_died',
    message: `The notebook kernel ended while the cell ran${tail ? `: ${tail}` : ''}. Run again to start a new one; what earlier cells defined is gone.`,
  };
}

/** Start the host the way the checkout's commands start: its uid, an environment from nothing, the prelude's limits. */
function spawnKernel(input: KernelInput): ChildProcess {
  const runInput: RunInput = {
    cwd: input.rootDir,
    home: input.home,
    identity: input.identity,
    env: input.env,
    timeoutMs: 0,
    extraEnv: {
      TMPDIR: `${input.home}/.cache/tmp`,
      ...(input.sandboxPython ? { RENKEI_SANDBOX_PYTHON: input.sandboxPython } : {}),
    },
  };
  const wrapped = wrapCommand(input.identity, 'bash', [
    '-c',
    `${shellPrelude()}${KERNEL_LAUNCH}`,
    'kernel',
    KERNEL_HOST_SOURCE,
    join(input.rootDir, dirname(input.path)),
  ]);
  return spawn(wrapped.file, wrapped.args, {
    cwd: input.rootDir,
    env: childEnvironment(runInput),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own group, so an interrupt reaches what a cell started too.
    detached: true,
  });
}
