/**
 * The facts line of the Actions card (actions-summary.tsx): how many
 * workflow files are on the branch and how many variables the runs get.
 * Tested in actions-summary.model.test.ts.
 */

import type { ActionsSummary } from '@/lib/code/github-actions';

export function summaryFacts(
  summary: Pick<ActionsSummary, 'workflowCount' | 'variableCount' | 'environmentCount'>,
  branch: string
): string[] {
  const branchLabel = branch || 'the default branch';
  const facts: string[] = [];
  if (summary.workflowCount === null) facts.push('workflows not checked');
  else if (summary.workflowCount === 0) facts.push(`no workflow files on ${branchLabel} yet`);
  else
    facts.push(
      `${summary.workflowCount} workflow file${summary.workflowCount === 1 ? '' : 's'} on ${branchLabel}`
    );
  if (summary.variableCount !== null) {
    facts.push(
      `${summary.variableCount} variable${summary.variableCount === 1 ? '' : 's'}` +
        (summary.environmentCount
          ? ` across the repository and ${summary.environmentCount} environment${summary.environmentCount === 1 ? '' : 's'}`
          : '')
    );
  }
  return facts;
}
