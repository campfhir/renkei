/**
 * The structural contract of the steps document, with branching. What's
 * pinned here is back-compat above all: a v1 document parses exactly as it
 * did before branches existed, a v2 document is rejected by nothing but
 * genuine malformation, and the walkers agree with the flat semantics on
 * linear docs (ordinal ≡ index) — that identity is what keeps old run
 * records readable.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_BRANCH_DEPTH,
  containsBranch,
  countNodes,
  findNodeById,
  flattenActionSteps,
  isAgentStepsDoc,
  isBranchStep,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type BranchStep,
} from './steps';

function action(overrides: Partial<ActionStep> = {}): ActionStep {
  return {
    id: randomUUID(),
    name: 'Do a thing',
    instruction: [{ t: 'text', v: 'Do it.' }],
    tool: null,
    maxAttempts: 1,
    failureHandling: [],
    ...overrides,
  };
}

function branch(overrides: Partial<BranchStep> = {}): BranchStep {
  return {
    id: randomUUID(),
    kind: 'branch',
    name: 'Anything urgent?',
    condition: [{ t: 'text', v: 'Is anything urgent?' }],
    paths: [
      { id: randomUUID(), name: 'Yes', steps: [action({ name: 'Escalate' })] },
      { id: randomUUID(), name: 'Otherwise', steps: [] },
    ],
    maxAttempts: 2,
    ...overrides,
  };
}

describe('isAgentStepsDoc', () => {
  it('accepts a v1 document exactly as before branching existed', () => {
    expect(isAgentStepsDoc({ version: 1, steps: [action()] })).toBe(true);
  });

  it('rejects a branch smuggled into a v1 document', () => {
    expect(isAgentStepsDoc({ version: 1, steps: [branch()] })).toBe(false);
  });

  it('accepts a v2 document with a branch', () => {
    expect(isAgentStepsDoc({ version: 2, steps: [action(), branch()] })).toBe(true);
  });

  it('accepts a nested branch at the allowed depth and rejects deeper', () => {
    const nested = branch({
      paths: [
        { id: randomUUID(), name: 'Yes', steps: [branch()] },
        { id: randomUUID(), name: 'No', steps: [] },
      ],
    });
    expect(MAX_BRANCH_DEPTH).toBe(2);
    expect(isAgentStepsDoc({ version: 2, steps: [nested] })).toBe(true);

    const tooDeep = branch({
      paths: [
        {
          id: randomUUID(),
          name: 'Yes',
          steps: [
            branch({
              paths: [
                { id: randomUUID(), name: 'Deeper', steps: [branch()] },
                { id: randomUUID(), name: 'No', steps: [] },
              ],
            }),
          ],
        },
        { id: randomUUID(), name: 'No', steps: [] },
      ],
    });
    expect(isAgentStepsDoc({ version: 2, steps: [tooDeep] })).toBe(false);
  });

  it('rejects a branch missing its second path', () => {
    const half = { ...branch(), paths: [branch().paths[0]] };
    expect(isAgentStepsDoc({ version: 2, steps: [half] })).toBe(false);
  });

  it('rejects unknown versions', () => {
    expect(isAgentStepsDoc({ version: 3, steps: [] })).toBe(false);
  });
});

describe('walkSteps', () => {
  it('gives ordinals equal to flat indexes on a linear document', () => {
    const nodes: AgentStepNode[] = [action(), action(), action()];
    const walked = walkSteps(nodes);
    expect(walked.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
    expect(walked.map((entry) => entry.path)).toEqual(['steps.0', 'steps.1', 'steps.2']);
    expect(walked.every((entry) => entry.depth === 1)).toBe(true);
  });

  it('walks pre-order through branch paths with recursive validator paths', () => {
    const inYes = action({ name: 'in yes' });
    const inNo = action({ name: 'in no' });
    const after = action({ name: 'after' });
    const fork = branch({
      paths: [
        { id: randomUUID(), name: 'Yes', steps: [inYes] },
        { id: randomUUID(), name: 'No', steps: [inNo] },
      ],
    });
    const walked = walkSteps([fork, after]);

    expect(walked.map((entry) => entry.node.name)).toEqual([
      'Anything urgent?',
      'in yes',
      'in no',
      'after',
    ]);
    expect(walked[1].path).toBe('steps.0.paths.0.steps.0');
    expect(walked[2].path).toBe('steps.0.paths.1.steps.0');
    // The node after the branch out-ordinals everything inside it —
    // the monotonicity step_index ordering relies on.
    expect(walked[3].ordinal).toBe(3);
    expect(walked[1].depth).toBe(2);
  });
});

describe('findNodeById', () => {
  it('returns the ancestor chain that locates a nested node', () => {
    const target = action({ name: 'nested' });
    const fork = branch({
      paths: [
        { id: randomUUID(), name: 'Yes', steps: [target] },
        { id: randomUUID(), name: 'No', steps: [] },
      ],
    });
    const found = findNodeById([action(), fork], target.id);

    expect(found?.node).toBe(target);
    expect(found?.ancestors).toHaveLength(1);
    expect(found?.ancestors[0].branch).toBe(fork);
    expect(found?.ancestors[0].path.name).toBe('Yes');
    expect(found?.index).toBe(0);
  });

  it('finds the branch node itself with no ancestors', () => {
    const fork = branch();
    const found = findNodeById([fork], fork.id);
    expect(found?.node).toBe(fork);
    expect(found?.ancestors).toEqual([]);
  });

  it('returns null for an unknown id', () => {
    expect(findNodeById([action()], 'nope')).toBeNull();
  });
});

describe('tree helpers', () => {
  it('flattenActionSteps skips branch nodes but keeps their children', () => {
    const fork = branch();
    const names = flattenActionSteps([action({ name: 'first' }), fork]).map((s) => s.name);
    expect(names).toEqual(['first', 'Escalate']);
  });

  it('countNodes counts branch nodes as one each', () => {
    expect(countNodes([action(), branch()])).toBe(3); // action + branch + its one child
  });

  it('containsBranch sees nested branches', () => {
    expect(containsBranch([action()])).toBe(false);
    expect(containsBranch([action(), branch()])).toBe(true);
    expect(isBranchStep(branch())).toBe(true);
  });
});
