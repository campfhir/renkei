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
 * Pure, so the mapping is unit-tested away from the query.
 */

import { isAgentStepsDoc, walkSteps } from '@renkei/agents';
import type { StepTokenUsage } from './agent-usage';

export function labelStepUsage<T extends Omit<StepTokenUsage, 'stepName' | 'stepNumber'>>(
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
