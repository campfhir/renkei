/**
 * Names for per-step token rows, from the agent's current definition.
 *
 * The ledger keys spend on the step's id; the name lives only in the
 * agent's steps document, which the owner edits freely. Resolving at
 * read time (rather than stamping the name on each ledger row) means a
 * renamed step keeps one history line under its new name, and a step
 * that no longer exists is still listed — its spend was real — with no
 * name, for the page to label as removed. A row with no step id at all
 * is spend outside any step (the optimizer's pass over the agent), and
 * is left unnamed too.
 *
 * Pure, so the mapping is unit-tested away from the query.
 */

import { findNodeById, isAgentStepsDoc } from '@renkei/agents';
import type { StepTokenUsage } from './agent-usage';

export function labelStepUsage<T extends Omit<StepTokenUsage, 'stepName'>>(
  stepsDoc: unknown,
  rows: readonly T[]
): (T & { stepName: string | null })[] {
  const doc = isAgentStepsDoc(stepsDoc) ? stepsDoc : null;
  return rows.map((row) => {
    if (row.stepId === null || doc === null) return { ...row, stepName: null };
    const found = findNodeById(doc.steps, row.stepId);
    const name = found && 'name' in found.node ? found.node.name : null;
    return { ...row, stepName: typeof name === 'string' && name.trim() ? name : null };
  });
}
