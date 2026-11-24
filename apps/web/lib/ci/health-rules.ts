/**
 * Health check-ins — the rules, with nothing of the server in them, so the
 * route that takes a check-in and the Environments page that shows one
 * read alike. Tested in health-rules.test.ts.
 *
 * An application that was deployed tells Renkei how it is: it POSTs a
 * status with the token its environment was issued, on a rhythm it
 * chooses. It is the developer's to implement and entirely optional — an
 * environment that never checked in shows nothing.
 *
 *   POST /api/health/check-in
 *   Authorization: Bearer <the environment's token>
 *   { "status": "healthy",                 // starting | healthy | degraded | error | stopping
 *     "message": "queue depth 3",          // optional, a line
 *     "version": "1.4.2",                  // optional: a version, tag or commit
 *     "sentAt": "2026-11-24T10:00:00Z",    // optional: when the application sent it
 *     "nextCheckInSeconds": 300 }          // optional: when to expect the next one
 *
 * `sentAt` is the application's own clock at the moment of sending, so a
 * check-in that spent time on the network counts from when it left; a
 * time that is not believable (in the future, or long past) is ignored
 * and the arrival is used. Without `nextCheckInSeconds` the next check-in
 * is expected within 60 minutes.
 *
 * Renkei never calls the application. Lateness is read from the last
 * check-in and the clock: once the next one is overdue the environment is
 * potentially failing, and when three in a row have been missed it is
 * failed. An application that said it was `stopping` is stopped, not late.
 */

import { isRecord } from '@renkei/guards';

export const HEALTH_STATUSES = ['starting', 'healthy', 'degraded', 'error', 'stopping'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** How long until the next check-in is due when the application does not say. */
export const DEFAULT_INTERVAL_SECONDS = 60 * 60;
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
/** Check-ins missed in a row before an environment is failed rather than potentially failing. */
export const MISSES_TO_FAIL = 3;
const MESSAGE_MAX_CHARS = 500;
const VERSION_MAX_CHARS = 120;
/** How far ahead of Renkei's clock an application's may run and still be believed. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** How old a `sentAt` may be and still be believed (a check-in queued while offline). */
const PAST_LIMIT_MS = 24 * 60 * 60 * 1000;

export interface Checkin {
  status: HealthStatus;
  message: string | null;
  version: string | null;
  /** When it counts from: the application's `sentAt` when believable, else its arrival. */
  sentAt: Date;
  /** Null for the default. */
  intervalSeconds: number | null;
}

/** A check-in as sent, read whole; what is wrong with it otherwise. */
export function readCheckin(
  body: unknown,
  receivedAt: Date
): { ok: true; checkin: Checkin } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'Send a JSON object with a status.' };
  const status = HEALTH_STATUSES.find((s) => s === body.status);
  if (!status) {
    return { ok: false, error: `status is one of ${HEALTH_STATUSES.join(', ')}.` };
  }
  let intervalSeconds: number | null = null;
  if (body.nextCheckInSeconds !== undefined && body.nextCheckInSeconds !== null) {
    const asked = body.nextCheckInSeconds;
    if (typeof asked !== 'number' || !Number.isFinite(asked)) {
      return { ok: false, error: 'nextCheckInSeconds is a number of seconds.' };
    }
    if (asked < MIN_INTERVAL_SECONDS || asked > MAX_INTERVAL_SECONDS) {
      return {
        ok: false,
        error: `nextCheckInSeconds is between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} (a week).`,
      };
    }
    intervalSeconds = Math.round(asked);
  }
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
  let sentAt = receivedAt;
  if (typeof body.sentAt === 'string' || typeof body.sentAt === 'number') {
    const claimed = new Date(body.sentAt).getTime();
    const age = receivedAt.getTime() - claimed;
    if (Number.isFinite(claimed) && age >= -FUTURE_SKEW_MS && age <= PAST_LIMIT_MS) {
      // A clock a little ahead of Renkei's is not a check-in from the future.
      sentAt = new Date(Math.min(claimed, receivedAt.getTime()));
    }
  }
  return {
    ok: true,
    checkin: {
      status,
      message: text(body.message, MESSAGE_MAX_CHARS),
      version: text(body.version, VERSION_MAX_CHARS),
      sentAt,
      intervalSeconds,
    },
  };
}

/** An environment's check-ins as the page gets them. */
export interface HealthView {
  /** The last characters of its token. */
  tokenHint: string;
  issuedAt: string;
  status: string | null;
  message: string | null;
  version: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  intervalSeconds: number | null;
  checkins: number;
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
export function readHealth(view: HealthView, now: number): HealthReading {
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

/** A length of time as people say it: "45 seconds", "5 minutes", "2 hours". */
export function spanLabel(seconds: number): string {
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (seconds < 90) return say(Math.round(seconds), 'second');
  if (seconds < 90 * 60) return say(Math.round(seconds / 60), 'minute');
  if (seconds < 36 * 3600) return say(Math.round(seconds / 3600), 'hour');
  return say(Math.round(seconds / 86400), 'day');
}

/** The variables an application reads its check-in from, as the page offers to save them. */
export const HEALTH_URL_VARIABLE = 'RENKEI_HEALTH_URL';
export const HEALTH_TOKEN_VARIABLE = 'RENKEI_HEALTH_TOKEN';
export const HEALTH_PATH = '/api/health/check-in';
