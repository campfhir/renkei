/**
 * Test connection as a job: the Sandboxes page starts it and is answered
 * at once, then reads it until it ends — passed, failed or cancelled (by
 * the operator or by the timeout). A test can take minutes (a disk image
 * built for this release, a sandbox that boots), which no single request
 * from a browser should be held open for: a phone that locks its screen,
 * or a proxy's idle timeout, would cut it off and lose the answer.
 *
 * One test at a time: starting one while another runs answers the one
 * running. The last one is kept after it ends, so the page shows its
 * steps and its answer when it is opened again. Each step is also a log
 * line. Jobs live in this process; a restart ends the one running (its
 * test sandbox, made without a record, is removed by the sweep).
 */

export type CheckJobState = 'running' | 'passed' | 'failed' | 'cancelled';

export interface CheckJobView {
  id: string;
  state: CheckJobState;
  /** What the test has done so far, in order. */
  steps: Array<{ at: string; text: string }>;
  /** The answer, once it has ended. */
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface CheckRun {
  signal: AbortSignal;
  step: (text: string) => void;
}

interface Job {
  view: CheckJobView;
  controller: AbortController;
  /** Why it was cancelled, when it was. */
  cancelledBecause: string | null;
}

export interface CheckJobsOptions {
  /** How long a test may run before it is cancelled. */
  timeoutMs?: number;
  newId: () => string;
  now?: () => Date;
  /** Each step as a log line. */
  onStep?: (job: CheckJobView, text: string) => void;
  onEnd?: (job: CheckJobView) => void;
}

const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const MAX_STEPS = 100;

export class CheckJobs {
  private job: Job | null = null;

  constructor(private readonly options: CheckJobsOptions) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private snapshot(job: Job): CheckJobView {
    return structuredClone(job.view);
  }

  /** The test running, or the last one, as the page shows it; null when there has been none. */
  current(): CheckJobView | null {
    return this.job ? this.snapshot(this.job) : null;
  }

  /**
   * Start a test, or answer the one already running. `run` is handed a
   * signal (cancelled by the operator or the timeout) and a way to say
   * each step; what it resolves to is the answer.
   */
  start(run: (context: CheckRun) => Promise<{ ok: boolean; detail: string }>): CheckJobView {
    if (this.job?.view.state === 'running') return this.snapshot(this.job);
    const controller = new AbortController();
    const job: Job = {
      view: {
        id: this.options.newId(),
        state: 'running',
        steps: [],
        detail: null,
        startedAt: this.now(),
        endedAt: null,
      },
      controller,
      cancelledBecause: null,
    };
    this.job = job;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(
      () =>
        this.cancelJob(
          job,
          `it ran past ${Math.round(timeoutMs / 60_000)} minutes, the longest a test may take`
        ),
      timeoutMs
    );
    timer.unref?.();
    const step = (text: string): void => {
      if (job.view.state !== 'running') return;
      if (job.view.steps.length < MAX_STEPS) job.view.steps.push({ at: this.now(), text });
      this.options.onStep?.(structuredClone(job.view), text);
    };
    void Promise.resolve()
      .then(() => run({ signal: controller.signal, step }))
      .then(
        (answer) => answer,
        (error: unknown) => ({
          ok: false,
          detail: `The test could not run: ${error instanceof Error ? error.message : String(error)}`,
        })
      )
      .then((answer) => {
        clearTimeout(timer);
        job.view.state = job.cancelledBecause ? 'cancelled' : answer.ok ? 'passed' : 'failed';
        job.view.detail = job.cancelledBecause
          ? `Cancelled: ${job.cancelledBecause}. ${answer.detail}`
          : answer.detail;
        job.view.endedAt = this.now();
        this.options.onEnd?.(structuredClone(job.view));
      });
    return this.snapshot(job);
  }

  private cancelJob(job: Job, because: string): void {
    if (job.view.state !== 'running' || job.cancelledBecause) return;
    job.cancelledBecause = because;
    job.controller.abort();
  }

  /**
   * Cancel the running test (`id`, when given, must be it). It ends once
   * what it was doing has stopped — a test sandbox removed — so it may
   * still read as running for a moment.
   */
  cancel(
    id: string | null,
    because = 'an operator stopped it on Organization → Sandboxes'
  ): CheckJobView | null {
    const job = this.job;
    if (job && (id === null || job.view.id === id)) this.cancelJob(job, because);
    return this.current();
  }
}
