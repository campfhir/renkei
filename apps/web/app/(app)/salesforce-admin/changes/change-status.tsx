/**
 * Human wording and color for a Salesforce admin change request's state and
 * its validation (lib/salesforce-admin/change-requests.ts) — the Jira admin
 * pill's shape.
 */

import type { ChangeRequestState, Validation } from '@/lib/salesforce-admin/change-requests';

const LABELS: Record<ChangeRequestState, string> = {
  pending: 'Waiting for review',
  applying: 'Deploying',
  applied: 'Applied',
  // Deployed, and a later step (a permission grant) did not finish.
  partial: 'Partly applied',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  interrupted: 'Interrupted',
};

function tone(state: ChangeRequestState): string {
  switch (state) {
    case 'applied':
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300';
    case 'partial':
    case 'interrupted':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
    case 'pending':
    case 'applying':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

export function ChangeStatePill({ state }: { state: ChangeRequestState }) {
  return (
    <span
      data-testid="change-state"
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone(state)}`}
    >
      {LABELS[state]}
    </span>
  );
}

export type ValidationState = 'passed' | 'checked' | 'failed' | 'running' | 'error' | 'none';

export function validationState(validation: Validation | null): ValidationState {
  if (!validation) return 'none';
  if ('error' in validation) return 'error';
  if (!validation.done) return 'running';
  // A change that is data only has no deploy for Salesforce to dry-run:
  // the proposal checked every name and id against the org instead.
  if (validation.success) return validation.deployId ? 'passed' : 'checked';
  return 'failed';
}

const VALIDATION_LABELS: Record<ValidationState, string> = {
  passed: 'Validated by Salesforce',
  checked: 'Checked against the org',
  failed: 'Validation failed',
  running: 'Validating…',
  error: 'Could not validate',
  none: 'Not validated',
};

export function ValidationPill({ validation }: { validation: Validation | null }) {
  const state = validationState(validation);
  const color =
    state === 'passed' || state === 'checked'
      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
      : state === 'running'
        ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
        : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
  return (
    <span
      data-testid="validation-state"
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {VALIDATION_LABELS[state]}
    </span>
  );
}
