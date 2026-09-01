/**
 * Human wording for run records. The database speaks in stable machine
 * strings (`step_failed`, `not-found`); pages render THESE labels instead —
 * built once here so the owner list, admin list, run timeline, and the
 * overview's recent-runs section all say the same thing.
 *
 * Pure data + string functions: importable from server and client alike.
 */

import { GENERIC_FAILURES, OTHER_FAILURE, CURATED_OUTCOMES } from '@/lib/mcp-tools/outcomes';

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
  // A graceful early end — a step judged the automation does not apply to
  // this input, so the rest was skipped. Deliberately not a failure and
  // not a plain success.
  stopped: 'Skipped',
  // Parked behind an approval card on the home page — the run continues
  // when the owner acts (or its wait ceiling routes the timeout path).
  waiting: 'Waiting for you',
};

/** Title-case label for a run or attempt status; unknown values capitalize. */
export function statusLabel(status: string): string {
  return (
    STATUS_LABELS[status] ?? (status ? status.charAt(0).toUpperCase() + status.slice(1) : status)
  );
}

/**
 * Statuses a run can still leave on its own — mirrors RUN_STATUSES in
 * runs-view.ts minus the terminal ones. Duplicated as a literal here,
 * rather than imported, because runs-view.ts pulls in kysely and
 * `@renkei/db` to run its queries — neither of which may reach the client
 * bundle that also needs this check (the run page's live view, deciding
 * whether to keep listening for more updates).
 */
const UNSETTLED_RUN_STATUSES = new Set(['queued', 'running', 'waiting']);

/** True once a run can never change again — nothing left for a live view to catch. */
export function isRunSettled(status: string): boolean {
  return !UNSETTLED_RUN_STATUSES.has(status);
}

/**
 * One phrase for why a run failed. `llm_rate_limit` and `guard` are in the
 * migration's taxonomy though today's engine never writes them — cheap
 * insurance. Unknown kinds pass through raw: never hide a truth we can't
 * translate.
 */
export function errorSummary(errorKind: string, failedStepName?: string | null): string {
  switch (errorKind) {
    case 'step_failed':
      return failedStepName ? `Failed on step: ${failedStepName}` : 'A step failed';
    case 'config':
      return 'Setup problem';
    case 'timeout':
      return 'Ran out of time';
    case 'llm_auth':
      return 'AI model sign-in problem';
    case 'llm_error':
      return 'AI model error';
    case 'llm_rate_limit':
      return 'AI model was busy';
    case 'guard':
      return 'Stopped by a safety guard';
    default:
      return errorKind;
  }
}

/**
 * Codes are stable identifiers by contract (outcomes.ts header), and the
 * few codes shared across curated tools carry interchangeable wording, so
 * a flat last-write-wins map is safe.
 */
const OUTCOME_CODE_LABELS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const failure of [...GENERIC_FAILURES, OTHER_FAILURE]) {
    map.set(failure.code, failure.label);
  }
  for (const outcomes of Object.values(CURATED_OUTCOMES)) {
    for (const failure of outcomes.failures) {
      map.set(failure.code, failure.label);
    }
  }
  return map;
})();

/** Human label for an attempt's outcome code; unknown codes pass through. */
export function outcomeCodeLabel(code: string): string {
  return OUTCOME_CODE_LABELS.get(code) ?? code;
}
