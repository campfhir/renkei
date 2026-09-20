import { isCoachAnchor } from './anchors';
import { tourById } from './tours';
import type { CoachMarkEvent, CoachMarkProgressView, CoachMarkStatus } from './types';

/**
 * How one reported event moves one person's row for one tour — pure, so
 * the API route's writer is a read, this, and a write, and the rules are
 * tested without a database.
 */

/** What the browser posts: validated against the registry, never trusted as is. */
export interface CoachMarkRecord {
  tourId: string;
  version: number;
  event: CoachMarkEvent;
  /** The 0-based step the event happened at. */
  step: number;
  stepsTotal: number;
  /**
   * The browser's clock when the event happened, ms. Reports are sent as
   * they happen and may land in any order; the reducer applies only one
   * newer than the row's last, so order of arrival cannot change the story.
   */
  at: number;
}

const EVENTS: readonly CoachMarkEvent[] = ['viewed', 'step', 'completed', 'dismissed'];

function isCoachMarkEvent(value: unknown): value is CoachMarkEvent {
  return typeof value === 'string' && EVENTS.some((event) => event === value);
}

function isSmallInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000;
}

/**
 * A body the route may act on, or null. The tour must exist; the step and
 * total are clamped to what the registry says the tour has, so a stale
 * page from before a tour was shortened cannot record a step it never
 * showed. The version is taken from the body (it is what the page ran),
 * but capped at the registry's — a future edition cannot be claimed.
 */
export function parseCoachMarkRecord(body: unknown): CoachMarkRecord | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw: Record<string, unknown> = { ...body };
  if (typeof raw.tourId !== 'string') return null;
  const tour = tourById(raw.tourId);
  if (!tour) return null;
  if (!isCoachMarkEvent(raw.event)) return null;
  const version = isSmallInt(raw.version) ? Math.min(raw.version, tour.version) : tour.version;
  const stepsTotal = tour.steps.length;
  const step = isSmallInt(raw.step) ? Math.min(raw.step, stepsTotal - 1) : 0;
  // A clock the server cannot check; a missing or absurd one reads as now,
  // which at worst lets a straggler through.
  const at =
    typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at > 0 && raw.at < 1e14
      ? Math.floor(raw.at)
      : Date.now();
  return {
    tourId: tour.id,
    version: Math.max(1, version),
    event: raw.event,
    step,
    stepsTotal,
    at,
  };
}

/** True when every step target in the registry is a known anchor — the tour test's helper. */
export function everyTargetKnown(targets: readonly (string | undefined)[]): boolean {
  return targets.every((target) => target === undefined || isCoachAnchor(target));
}

/**
 * The row after the event. `existing` is null when this person has never
 * seen the tour. `now` is an ISO timestamp so the reducer is deterministic.
 *
 * - `viewed` starts a pass: the status goes back to 'viewed', the step
 *   counter to 0, and the view count up by one. A pass that never got a
 *   'viewed' (the request was lost) is started by whatever arrives first.
 * - `step` only raises `stepReached` — going Back never lowers it.
 * - `completed` and `dismissed` settle the pass and bump their counter.
 *   Both keep the higher of the current step and the one reported.
 * - A report older than the row's last applied one is a straggler that
 *   arrived out of order, and changes nothing.
 */
export function applyCoachMarkEvent(
  existing: CoachMarkProgressView | null,
  record: CoachMarkRecord,
  now: string
): CoachMarkProgressView {
  if (existing && record.at <= Date.parse(existing.reportedAt)) return existing;
  const reportedAt = new Date(record.at).toISOString();

  const base: CoachMarkProgressView = existing ?? {
    tourId: record.tourId,
    version: record.version,
    status: 'viewed',
    stepReached: 0,
    stepsTotal: record.stepsTotal,
    viewCount: 0,
    completedCount: 0,
    dismissedCount: 0,
    firstViewedAt: now,
    lastViewedAt: now,
    completedAt: null,
    dismissedAt: null,
    reportedAt,
  };

  // A pass begins with 'viewed'; any other event without one is the same
  // pass, just with its opening report lost in transit.
  const opening = record.event === 'viewed' || existing === null;
  const started: CoachMarkProgressView = opening
    ? {
        ...base,
        version: record.version,
        status: 'viewed',
        stepReached: 0,
        stepsTotal: record.stepsTotal,
        viewCount: base.viewCount + 1,
        lastViewedAt: now,
        reportedAt,
      }
    : { ...base, reportedAt };

  const stepReached = Math.max(started.stepReached, record.step);
  let status: CoachMarkStatus = started.status;
  let completedCount = started.completedCount;
  let dismissedCount = started.dismissedCount;
  let completedAt = started.completedAt;
  let dismissedAt = started.dismissedAt;

  switch (record.event) {
    case 'completed':
      status = 'completed';
      completedCount += 1;
      completedAt = now;
      break;
    case 'dismissed':
      status = 'dismissed';
      dismissedCount += 1;
      dismissedAt = now;
      break;
    case 'step':
    case 'viewed':
      // A 'step' after a pass settled — a Back the person pressed, then a
      // Skip that overtook it — is that pass's, and must not reopen it.
      if (!opening && status !== 'viewed') return started;
      status = 'viewed';
      break;
  }

  return {
    ...started,
    status,
    stepReached: record.event === 'completed' ? record.stepsTotal - 1 : stepReached,
    completedCount,
    dismissedCount,
    completedAt,
    dismissedAt,
  };
}
