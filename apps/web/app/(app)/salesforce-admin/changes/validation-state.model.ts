/**
 * Which validation badge a Salesforce admin change request wears
 * (change-status.tsx), on its review page and in both lists. Tested in
 * validation-state.model.test.ts.
 */

import type { Validation } from '@/lib/salesforce-admin/change-requests';

export type ValidationState =
  'passed' | 'checked' | 'failed' | 'tests' | 'running' | 'error' | 'none';

/**
 * `testsShort`: the change carries Apex and its validation's tests do not
 * allow a deploy (a failing test, or a changed class under the coverage
 * bar) — what the caller worked out from the payload. Salesforce passes a
 * sandbox validation whatever the coverage, so that badge must not say
 * "Validated" for a change that cannot be approved.
 */
export function validationState(
  validation: Validation | null,
  testsShort = false
): ValidationState {
  if (!validation) return 'none';
  if ('error' in validation) return 'error';
  if (!validation.done) return 'running';
  if (testsShort) return 'tests';
  // A change that is data only has no deploy for Salesforce to dry-run:
  // the proposal checked every name and id against the org instead.
  if (validation.success) return validation.deployId ? 'passed' : 'checked';
  return 'failed';
}

export const VALIDATION_LABELS: Record<ValidationState, string> = {
  passed: 'Validated by Salesforce',
  checked: 'Checked against the org',
  failed: 'Validation failed',
  tests: 'Tests short',
  running: 'Validating…',
  error: 'Could not validate',
  none: 'Not validated',
};
