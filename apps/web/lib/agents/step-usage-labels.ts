/**
 * Names and numbers for per-step token rows, from the agent's current
 * definition.
 *
 * The ledger keys spend on the step's id; the name lives only in the
 * agent's steps document, which the owner edits freely. Resolving at
 * read time (rather than stamping the name on each ledger row) means a
 * renamed step keeps one history line under its new name, and a step
 * that no longer exists is still listed — its spend was real — with no
 * name, for the page to label as removed. The number is the step's
 * position in the same pre-order walk the steps outline numbers by, so
 * "3." here is "3." there. A row with no step id at all is spend outside
 * any step (the optimizer's pass over the agent), and is left unnamed
 * and unnumbered too.
 *
 * Pure, so the mapping is unit-tested away from the query. Given a run's
 * own steps snapshot instead of the agent's definition, the same walk
 * names the steps as they stood when that run happened.
 */

import { isAgentStepsDoc, walkSteps } from '@renkei/agents';

/**
 * Generic over any row keyed on a step id — the agent's calendar-bucketed
 * rows and a single run's plain totals alike; only `stepId` is read.
 */
export function labelStepUsage<T extends { stepId: string | null }>(
  stepsDoc: unknown,
  rows: readonly T[]
): (T & { stepName: string | null; stepNumber: number | null })[] {
  const walked = isAgentStepsDoc(stepsDoc) ? walkSteps(stepsDoc.steps) : [];
  const byId = new Map(walked.map((entry) => [entry.node.id, entry]));
  return rows.map((row) => {
    const found = row.stepId === null ? undefined : byId.get(row.stepId);
    if (!found) return { ...row, stepName: null, stepNumber: null };
    const name = 'name' in found.node ? found.node.name : null;
    return {
      ...row,
      stepName: typeof name === 'string' && name.trim() ? name : null,
      stepNumber: found.ordinal + 1,
    };
  });
}
