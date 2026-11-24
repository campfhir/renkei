/**
 * How a deployed application is, read from its last health check-in and
 * the clock — with nothing of a server in it, so the Environments page,
 * the tools that answer a chat or an agent, and the worker's sweep that
 * notices an application gone quiet all read alike. Tested in
 * health.test.ts; the check-in itself is apps/web/lib/ci/health-rules.ts.
 *
 * Renkei never calls the application. Once the next check-in is overdue
 * the environment is potentially failing (`late`), when three in a row
 * have been missed it is `failed`, and one that said it was `stopping`
 * and then went quiet is `stopped`.
 */

export const HEALTH_STATUSES = ['starting', 'healthy', 'degraded', 'error', 'stopping'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** How long until the next check-in is due when the application does not say. */
export const DEFAULT_INTERVAL_SECONDS = 60 * 60;
/** Check-ins missed in a row before an environment is failed rather than potentially failing. */
export const MISSES_TO_FAIL = 3;

/** What of a check-in the reading needs. */
export interface HealthSource {
  status: string | null;
  /** When the last check-in counts from (ISO). */
  sentAt: string | null;
  intervalSeconds: number | null;
}

export type HealthState =
  /** A token was issued; nothing has checked in with it yet. */
  | 'waiting'
  | HealthStatus
  /** The next check-in is overdue. */
  | 'late'
  /** Three in a row were missed. */
  | 'failed'
  /** It said it was stopping, and has not checked in since. */
  | 'stopped';

export interface HealthReading {
  state: HealthState;
  /** Check-ins missed in a row since the last one. */
  missed: number;
  /** When the next one is due (ISO); null before the first. */
  dueAt: string | null;
  intervalSeconds: number;
}

/**
 * How an environment is, from its last check-in and the clock. A check-in
 * is not late the instant it is due: it has a tenth of its interval (at
 * least half a minute, at most five) to arrive.
 */
export function readHealth(view: HealthSource, now: number): HealthReading {
  const intervalSeconds = view.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const status = HEALTH_STATUSES.find((s) => s === view.status);
  if (!status || !view.sentAt) {
    return { state: 'waiting', missed: 0, dueAt: null, intervalSeconds };
  }
  const interval = intervalSeconds * 1000;
  const due = Date.parse(view.sentAt) + interval;
  const grace = Math.min(5 * 60_000, Math.max(30_000, interval / 10));
  const overdue = now - due - grace;
  const dueAt = new Date(due).toISOString();
  if (overdue <= 0) return { state: status, missed: 0, dueAt, intervalSeconds };
  const missed = 1 + Math.floor(overdue / interval);
  if (status === 'stopping') return { state: 'stopped', missed, dueAt, intervalSeconds };
  return {
    state: missed >= MISSES_TO_FAIL ? 'failed' : 'late',
    missed,
    dueAt,
    intervalSeconds,
  };
}

/** Every state an environment can be announced in: `waiting` is not one, nothing has happened yet. */
export const HEALTH_STATES: readonly HealthState[] = [
  ...HEALTH_STATUSES,
  'late',
  'failed',
  'stopped',
];

/** The states that need someone: it reports a problem, went quiet, or stopped. */
const TROUBLED: readonly HealthState[] = ['degraded', 'error', 'late', 'failed', 'stopped'];
export function isTroubled(state: string | null): boolean {
  return TROUBLED.some((s) => s === state);
}

export interface HealthChange {
  /** The state last announced; null when none was. */
  from: string | null;
  to: HealthState;
  missed: number;
}

/**
 * The change to announce, if there is one: the environment's state now is
 * not the one last announced. Nothing before the first check-in.
 */
export function healthChange(
  source: HealthSource & { announcedState: string | null },
  now: number
): HealthChange | null {
  const reading = readHealth(source, now);
  if (reading.state === 'waiting' || reading.state === source.announcedState) return null;
  return { from: source.announcedState, to: reading.state, missed: reading.missed };
}
