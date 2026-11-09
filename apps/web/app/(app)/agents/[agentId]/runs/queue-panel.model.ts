/**
 * The runs page's Queue panel: where an agent's work actually is. A run's
 * status says "queued"; this says why — which job is at the head of the
 * agent's queue (one agent's runs go one at a time), what state it is in,
 * how many deliveries it has had, how long, and the last error, plus the
 * jobs the queue gave up on. Pure: the page passes the jobs (the queue
 * store's listAgentJobs and listAgentDeadLetters) and the clock.
 *
 * The verdicts:
 *  - held: the head is being processed, but its worker stopped renewing
 *    its lease (it renews every few minutes while it works) — it died or
 *    hung, and the queue will reclaim it or give up on it;
 *  - retrying: the head failed and waits to be tried again;
 *  - not picked up: the head has been due for a while and no worker has
 *    claimed it — no agents worker is taking jobs;
 *  - moving: a worker has the head now, or it is next and just arrived.
 */

/** A job as the page hands it over (ISO times). */
export interface QueueJob {
  id: string;
  type: string;
  runId: string | null;
  batchId: string | null;
  status: string;
  attempts: number;
  lockedAt: string | null;
  runAfter: string;
  lastError: string | null;
  createdAt: string;
}

export interface QueueDeadJob {
  id: string;
  type: string;
  runId: string | null;
  batchId: string | null;
  attempts: number;
  lastError: string | null;
  deadAt: string;
}

export type QueueVerdict = 'clear' | 'moving' | 'retrying' | 'held' | 'not-picked-up';

export interface QueueLine {
  /** The run it is about, for a link; null for one with no run. */
  runId: string | null;
  text: string;
  error: string | null;
}

export interface QueuePanel {
  verdict: QueueVerdict;
  /** One sentence on the head of the queue. */
  headline: string;
  head: QueueLine | null;
  /** Runs waiting behind the head ("50+" when the read was cut off). */
  behind: string;
  /** The agent's change batches waiting to be made or being made. */
  batches: QueueLine[];
  /** Jobs the queue gave up on, most recent first. */
  gaveUp: QueueLine[];
  /** Whether there is anything to show at all. */
  visible: boolean;
}

/** A worker renews its lease every few minutes; past this, it has stopped. */
export const LEASE_STALE_MS = 30 * 60_000;
/** Due this long with nobody claiming it, the head is not being picked up. */
export const NOT_PICKED_UP_MS = 5 * 60_000;
/** Dead letters older than this are history, not news. */
const GAVE_UP_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** "45 s", "12 min", "3 h", "4 d". */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortId = (id: string | null) => (id ? id.slice(0, 8) : 'a job');

function headLine(job: QueueJob, nowMs: number): { verdict: QueueVerdict; line: QueueLine } {
  const run = `Run ${shortId(job.runId)}`;
  const tries = plural(job.attempts, 'delivery', 'deliveries');
  const error = job.lastError;
  if (job.status === 'processing') {
    const lockedFor = job.lockedAt ? nowMs - Date.parse(job.lockedAt) : Infinity;
    if (lockedFor > LEASE_STALE_MS) {
      return {
        verdict: 'held',
        line: {
          runId: job.runId,
          text: `${run} is holding the queue: its worker stopped renewing it ${span(lockedFor)} ago (${tries} so far). The queue will reclaim it, or give up after its last try.`,
          error,
        },
      };
    }
    return {
      verdict: 'moving',
      line: {
        runId: job.runId,
        text: `${run} is being worked on now (${tries}).`,
        error,
      },
    };
  }
  const dueIn = Date.parse(job.runAfter) - nowMs;
  if (dueIn > 0) {
    return {
      verdict: 'retrying',
      line: {
        runId: job.runId,
        text: `${run} failed and is tried again in ${span(dueIn)} (${tries} so far).`,
        error,
      },
    };
  }
  const waiting = nowMs - Math.max(Date.parse(job.createdAt), Date.parse(job.runAfter));
  if (waiting > NOT_PICKED_UP_MS) {
    return {
      verdict: 'not-picked-up',
      line: {
        runId: job.runId,
        text: `${run} is next, and no worker has picked it up in ${span(waiting)} — the agents worker is not taking jobs.`,
        error,
      },
    };
  }
  return {
    verdict: 'moving',
    line: { runId: job.runId, text: `${run} is next.`, error },
  };
}

/**
 * The panel for `jobs` (oldest first, at most `limit` of them) and
 * `dead` (most recent first) at `nowMs`.
 */
export function queuePanel(
  jobs: readonly QueueJob[],
  dead: readonly QueueDeadJob[],
  nowMs: number,
  limit: number
): QueuePanel {
  const runs = jobs.filter((job) => job.type === 'run');
  const head = runs[0];
  const verdictAndLine = head ? headLine(head, nowMs) : null;
  const behindCount = Math.max(0, runs.length - 1);
  const gaveUp = dead
    .filter((job) => nowMs - Date.parse(job.deadAt) <= GAVE_UP_WINDOW_MS)
    .slice(0, 5)
    .map((job) => ({
      runId: job.runId,
      text: `Gave up on ${job.type === 'actions' ? 'a change batch of run' : 'run'} ${shortId(job.runId)} after ${plural(job.attempts, 'delivery', 'deliveries')}, ${span(nowMs - Date.parse(job.deadAt))} ago.`,
      error: job.lastError,
    }));
  const batches = jobs
    .filter((job) => job.type === 'actions')
    .map((job) => ({
      runId: job.runId,
      text: `A change batch (${shortId(job.batchId)}) is ${job.status === 'processing' ? 'being made' : 'waiting to be made'} (${plural(job.attempts, 'delivery', 'deliveries')}).`,
      error: job.lastError,
    }));

  const verdict = verdictAndLine?.verdict ?? 'clear';
  return {
    verdict,
    headline: verdictAndLine ? verdictAndLine.line.text : 'Nothing is queued for this agent.',
    head: verdictAndLine?.line ?? null,
    behind: jobs.length >= limit && behindCount > 0 ? `${behindCount}+` : String(behindCount),
    batches,
    gaveUp,
    visible: jobs.length > 0 || gaveUp.length > 0,
  };
}
