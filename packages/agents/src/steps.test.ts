/**
 * The structural contract of the steps document. One guard for every
 * stored version: an old document's NODES always parse (today's shapes
 * are supersets of everything this product ever wrote), so run records
 * stay readable and stale agents open in the builder — while
 * isCurrentStepsDoc pins the stricter question of what may RUN.
 */

import { randomUUID } from 'node:crypto';
import {
  CURRENT_STEPS_VERSION,
  countNodes,
  findNodeById,
  flattenActionSteps,
  isAgentStepsDoc,
  isBranchStep,
  isCurrentStepsDoc,
  nodeUsesModel,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type BranchStep,
  type TerminalStep,
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

  it('never lets the version number constrain structure — old docs LOAD', () => {
    // The builder must be able to open a stale agent so its owner can
    // update it; the version number decides only whether it may RUN.
    expect(isAgentStepsDoc({ version: 1, steps: [branch()] })).toBe(true);
    expect(isAgentStepsDoc({ version: 3, steps: [loop(), group()] })).toBe(true);
  });

  it('accepts every failure-handling action, and only those', () => {
    // Plain object literals, not the typed helper: the guard takes unknown,
    // and the point is exactly which action STRINGS it admits.
    const doc = (handlingAction: string): unknown => ({
      version: 1,
      steps: [
        {
          id: randomUUID(),
          name: 'Find it',
          instruction: [{ t: 'text', v: 'Find it.' }],
          tool: 'jira_get_issue',
          maxAttempts: 1,
          failureHandling: [{ outcome: 'not-found', action: handlingAction }],
        },
      ],
    });
    expect(isAgentStepsDoc(doc('exit'))).toBe(true);
    expect(isAgentStepsDoc(doc('retry'))).toBe(true);
    // 'stop-quiet' = the owner declared the outcome benign (not an error).
    expect(isAgentStepsDoc(doc('stop-quiet'))).toBe(true);
    // 'continue' = record the failure, move on (v7 vocabulary; the shared
    // guard admits it and requiredVersion labels the doc 7 — the date-chip
    // pattern).
    expect(isAgentStepsDoc(doc('continue'))).toBe(true);
    expect(isAgentStepsDoc(doc('explode'))).toBe(false);
  });

  it('accepts the v7 exhausted choices, and only those', () => {
    const doc = (exhausted: string): unknown => ({
      version: 7,
      steps: [
        {
          id: randomUUID(),
          name: 'Find it',
          instruction: [{ t: 'text', v: 'Find it.' }],
          tool: 'jira_search_issues',
          maxAttempts: 3,
          failureHandling: [
            {
              outcome: 'no-results',
              action: 'retry',
              guidance: [{ t: 'text', v: 'Reword the search.' }],
              exhausted,
            },
          ],
        },
      ],
    });
    expect(isAgentStepsDoc(doc('exit'))).toBe(true);
    expect(isAgentStepsDoc(doc('continue'))).toBe(true);
    expect(isAgentStepsDoc(doc('stop-quiet'))).toBe(true);
    expect(isAgentStepsDoc(doc('give-up'))).toBe(false);
  });

  it('accepts a v2 document with a branch', () => {
    expect(isAgentStepsDoc({ version: 2, steps: [action(), branch()] })).toBe(true);
  });

  it('accepts nesting to the current depth and rejects deeper', () => {
    // branch > branch > branch is the deepest legal branch shape.
    const threeDeep = branch({
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
    expect(isAgentStepsDoc({ version: 8, steps: [threeDeep] })).toBe(true);

    const fourDeep = branch({
      paths: [
        { id: randomUUID(), name: 'Yes', steps: [threeDeep] },
        { id: randomUUID(), name: 'No', steps: [] },
      ],
    });
    expect(isAgentStepsDoc({ version: 8, steps: [fourDeep] })).toBe(false);
  });

  it('rejects a branch missing its second path', () => {
    const half = { ...branch(), paths: [branch().paths[0]] };
    expect(isAgentStepsDoc({ version: 2, steps: [half] })).toBe(false);
  });

  it('rejects versions outside 1..current', () => {
    expect(isAgentStepsDoc({ version: CURRENT_STEPS_VERSION + 1, steps: [] })).toBe(false);
    expect(isAgentStepsDoc({ version: 0, steps: [] })).toBe(false);
    expect(isAgentStepsDoc({ version: 2.5, steps: [] })).toBe(false);
    expect(isAgentStepsDoc({ version: CURRENT_STEPS_VERSION, steps: [] })).toBe(true);
  });

  it('isCurrentStepsDoc demands exactly the current version', () => {
    expect(CURRENT_STEPS_VERSION).toBe(9);
    expect(isCurrentStepsDoc({ version: CURRENT_STEPS_VERSION, steps: [action()] })).toBe(true);
    // Loads, but may not run — the disable-and-notify path's trigger.
    expect(isCurrentStepsDoc({ version: 7, steps: [action()] })).toBe(false);
    expect(isAgentStepsDoc({ version: 7, steps: [action()] })).toBe(true);
  });

  it('admits terminal nodes at any loaded version, rejecting malformation', () => {
    const terminal = {
      id: randomUUID(),
      kind: 'terminal',
      name: 'Give up',
      result: 'failure',
      message: [{ t: 'text', v: 'It broke.' }],
    };
    expect(isAgentStepsDoc({ version: 4, steps: [terminal] })).toBe(true);
    expect(isAgentStepsDoc({ version: 3, steps: [terminal] })).toBe(true);
    expect(isAgentStepsDoc({ version: 4, steps: [{ ...terminal, result: 'explode' }] })).toBe(
      false
    );
  });

  it('still admits a terminal node saved before notifyEmail/notifyWebex were removed', () => {
    // Extra properties from an older doc shape are ignored, not rejected —
    // the same tolerance any other unrecognized field gets.
    const terminal = {
      id: randomUUID(),
      kind: 'terminal',
      name: 'Give up',
      result: 'failure',
      message: [{ t: 'text', v: 'It broke.' }],
      notifyEmail: true,
      notifyWebex: false,
    };
    expect(isAgentStepsDoc({ version: 4, steps: [terminal] })).toBe(true);
  });

  it('admits the v8 handling vocabulary and rejects a malformed when', () => {
    const doc = (when: unknown): unknown => ({
      version: 8,
      steps: [
        {
          id: randomUUID(),
          name: 'Find it',
          instruction: [{ t: 'text', v: 'Find it.' }],
          tool: 'jira_search_issues',
          maxAttempts: 1,
          failureHandling: [
            {
              outcome: 'stale-data',
              action: 'continue',
              guidance: [{ t: 'text', v: 'Note it and move on.' }],
              ...(when === undefined ? {} : { when }),
            },
          ],
        },
      ],
    });
    expect(isAgentStepsDoc(doc('the report is older than 30 days'))).toBe(true);
    expect(isAgentStepsDoc(doc(undefined))).toBe(true);
    expect(isAgentStepsDoc(doc(42))).toBe(false);
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
    const ancestor = found?.ancestors[0];
    expect(ancestor?.kind).toBe('branch');
    if (ancestor?.kind === 'branch') {
      expect(ancestor.branch).toBe(fork);
      expect(ancestor.path.name).toBe('Yes');
    }
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

function loop(overrides: Partial<import('./steps').ForEachLoopStep> = {}) {
  const node: import('./steps').ForEachLoopStep = {
    id: randomUUID(),
    kind: 'loop',
    mode: 'foreach',
    name: 'For each ticket',
    itemsVar: 'found tickets',
    itemVar: 'ticket',
    maxIterations: 10,
    steps: [action({ name: 'Handle one' })],
    ...overrides,
  };
  return node;
}

function group(overrides: Partial<import('./steps').GroupStep> = {}) {
  const node: import('./steps').GroupStep = {
    id: randomUUID(),
    kind: 'group',
    name: 'Triage',
    steps: [action({ name: 'grouped' })],
    ...overrides,
  };
  return node;
}

describe('version 3 structures', () => {
  it('walks loop and group children with uniform paths and depth', () => {
    const inner = action({ name: 'inner' });
    const looped = loop({ steps: [inner] });
    const grouped = group({ steps: [action({ name: 'in group' })] });
    const walked = walkSteps([looped, grouped]);

    expect(walked.map((entry) => entry.node.name)).toEqual([
      'For each ticket',
      'inner',
      'Triage',
      'in group',
    ]);
    expect(walked[1].path).toBe('steps.0.steps.0');
    expect(walked[3].path).toBe('steps.1.steps.0');
    expect(walked[1].depth).toBe(2);
  });

  it('walks a branch failurePath and finds nodes inside it', () => {
    const rescue = action({ name: 'rescue' });
    const fork = branch({
      failurePath: { id: randomUUID(), name: 'On failure', steps: [rescue] },
    });
    const walked = walkSteps([fork]);
    expect(walked.map((e) => e.node.name)).toContain('rescue');
    expect(walked.find((e) => e.node.name === 'rescue')?.path).toBe('steps.0.failurePath.steps.0');

    const found = findNodeById([fork], rescue.id);
    expect(found?.ancestors[0]?.kind).toBe('branch');
    if (found?.ancestors[0]?.kind === 'branch') {
      expect(found.ancestors[0].isFailurePath).toBe(true);
    }
  });

  it('findNodeById reports loop and group ancestors', () => {
    const inner = action({ name: 'inner' });
    const doc = [group({ steps: [loop({ steps: [inner] })] })];
    const found = findNodeById(doc, inner.id);
    expect(found?.ancestors.map((a) => a.kind)).toEqual(['group', 'loop']);
  });

  it('the guard accepts the container constructs and enforces its limits', () => {
    expect(isAgentStepsDoc({ version: 3, steps: [loop(), group(), branch()] })).toBe(true);
    // No nested loops.
    expect(isAgentStepsDoc({ version: 3, steps: [loop({ steps: [loop()] })] })).toBe(false);
    // Path count bounds.
    const sixPaths = branch({
      paths: Array.from({ length: 6 }, (_, i) => ({
        id: randomUUID(),
        name: `P${i}`,
        steps: [],
      })),
    });
    expect(isAgentStepsDoc({ version: 3, steps: [sixPaths] })).toBe(false);
    const fivePaths = branch({
      paths: Array.from({ length: 5 }, (_, i) => ({
        id: randomUUID(),
        name: `P${i}`,
        steps: [],
      })),
    });
    expect(isAgentStepsDoc({ version: 3, steps: [fivePaths] })).toBe(true);
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

  it('isBranchStep discriminates', () => {
    expect(isBranchStep(branch())).toBe(true);
    expect(isBranchStep(action())).toBe(false);
  });
});

describe('needsApproval gate (version 9)', () => {
  const gated = (overrides: Partial<ActionStep> = {}): ActionStep =>
    action({
      name: 'Post the comment',
      tool: 'jira_add_comment',
      needsApproval: true,
      approvalTimeoutHours: 96,
      onNotApproved: { id: randomUUID(), name: 'Skip it', steps: [] },
      ...overrides,
    });

  it('admits a gated action step at any loaded version, rejecting malformation', () => {
    const node = gated();
    expect(isAgentStepsDoc({ version: 9, steps: [node] })).toBe(true);
    expect(isAgentStepsDoc({ version: 8, steps: [node] })).toBe(true);
    expect(isAgentStepsDoc({ version: 9, steps: [{ ...node, needsApproval: 'yes' }] })).toBe(false);
    expect(isAgentStepsDoc({ version: 9, steps: [{ ...node, onNotApproved: { id: 'x' } }] })).toBe(
      false
    );
  });

  it('a gate with no recovery path is still valid — empty/absent just continues', () => {
    const node = gated({ onNotApproved: undefined });
    expect(isAgentStepsDoc({ version: 9, steps: [node] })).toBe(true);
  });

  it('rejects the removed approval node shape outright', () => {
    const oldApproval = {
      id: randomUUID(),
      kind: 'approval',
      name: 'Ship it?',
      message: [{ t: 'text', v: 'OK to send the report?' }],
      mode: 'approve',
      timeoutHours: 72,
      notifyEmail: true,
      notifyWebex: false,
      onApproved: { id: randomUUID(), name: 'Approved', steps: [] },
      onDeclined: { id: randomUUID(), name: 'Rejected', steps: [] },
      onTimeout: { id: randomUUID(), name: 'No answer in time', steps: [] },
    };
    expect(isAgentStepsDoc({ version: 5, steps: [oldApproval] })).toBe(false);
    expect(isAgentStepsDoc({ version: CURRENT_STEPS_VERSION, steps: [oldApproval] })).toBe(false);
  });

  it('admits terminals inside the recovery path', () => {
    const terminal: TerminalStep = {
      id: randomUUID(),
      kind: 'terminal',
      name: 'Stop',
      result: 'stop',
      message: [],
    };
    const node = gated({ onNotApproved: { id: randomUUID(), name: 'R', steps: [terminal] } });
    expect(isAgentStepsDoc({ version: CURRENT_STEPS_VERSION, steps: [node] })).toBe(true);
  });

  it('walks and finds nodes inside the recovery path with the gate grammar', () => {
    const inner: ActionStep = {
      id: randomUUID(),
      name: 'Record the skip',
      instruction: [{ t: 'text', v: 'note it' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    };
    const node = gated({ onNotApproved: { id: randomUUID(), name: 'Skip it', steps: [inner] } });
    const walked = walkSteps([node]);
    expect(walked.map((entry) => entry.path)).toEqual(['steps.0', 'steps.0.onNotApproved.steps.0']);

    const found = findNodeById([node], inner.id);
    expect(found?.ancestors).toHaveLength(1);
    const ancestor = found?.ancestors[0];
    expect(ancestor?.kind).toBe('gate');
    if (ancestor?.kind === 'gate') expect(ancestor.step).toBe(node);
  });

  it('counts a gate toward the container nesting budget, not the branch one', () => {
    // A gate's recovery path is structurally like a loop/group level — it
    // costs a container slot, never a branch-decision slot.
    const deepBranch = (steps: AgentStepNode[]): BranchStep => ({
      id: randomUUID(),
      kind: 'branch',
      name: 'B',
      condition: [{ t: 'text', v: 'x?' }],
      paths: [
        { id: randomUUID(), name: 'Yes', steps },
        { id: randomUUID(), name: 'No', steps: [] },
      ],
      maxAttempts: 2,
    });
    // Four container levels (the cap) inside the gate's recovery path is
    // fine; a fifth is not.
    const fourDeep = gated({
      onNotApproved: {
        id: randomUUID(),
        name: 'Skip it',
        steps: [deepBranch([deepBranch([deepBranch([])])])],
      },
    });
    expect(isAgentStepsDoc({ version: 9, steps: [fourDeep] })).toBe(true);

    const fiveDeep = gated({
      onNotApproved: {
        id: randomUUID(),
        name: 'Skip it',
        steps: [deepBranch([deepBranch([deepBranch([deepBranch([])])])])],
      },
    });
    expect(isAgentStepsDoc({ version: 9, steps: [fiveDeep] })).toBe(false);
  });
});

/**
 * The table the builder canvas marks nodes from. It mirrors the engine's
 * dispatch switch, which lives in another app and so cannot be asserted
 * against from here — this test is the next best thing: an explicit,
 * readable statement of the claim, so changing it is a deliberate edit
 * rather than a silent drift.
 */
describe('nodeUsesModel', () => {
  const id = () => randomUUID();
  const body = (): AgentStepNode[] => [
    {
      id: id(),
      name: 'Do',
      instruction: [{ t: 'text', v: 'x' }],
      tool: 'jira_get_issue',
      maxAttempts: 1,
      failureHandling: [],
    },
  ];

  it('is true for an action step with a tool', () => {
    expect(nodeUsesModel(body()[0]!)).toBe(true);
  });

  it('is true for an action step with NO tool — that one is nothing but a model', () => {
    // The case most likely to be got backwards. A step with no tool is not
    // a smaller step; it is pure reasoning with nothing grounding it.
    expect(
      nodeUsesModel({
        id: id(),
        kind: 'action',
        name: 'Think',
        instruction: [{ t: 'text', v: 'summarize' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      })
    ).toBe(true);
  });

  it('is true for a branch — the condition is model-evaluated', () => {
    expect(
      nodeUsesModel({
        id: id(),
        kind: 'branch',
        name: 'B',
        condition: [{ t: 'text', v: 'urgent?' }],
        paths: [{ id: id(), name: 'Yes', steps: [] }],
        maxAttempts: 2,
      })
    ).toBe(true);
  });

  it('splits the two loop modes — the one node that depends on a field', () => {
    expect(
      nodeUsesModel({
        id: id(),
        kind: 'loop',
        mode: 'foreach',
        name: 'Each',
        itemsVar: 'items',
        itemVar: 'item',
        maxIterations: 10,
        steps: body(),
      })
    ).toBe(false);

    expect(
      nodeUsesModel({
        id: id(),
        kind: 'loop',
        mode: 'until',
        name: 'Until',
        condition: [{ t: 'text', v: 'done?' }],
        maxAttempts: 2,
        maxIterations: 10,
        steps: body(),
      })
    ).toBe(true);
  });

  it('is false for a group', () => {
    expect(nodeUsesModel({ id: id(), kind: 'group', name: 'G', steps: body() })).toBe(false);
  });

  it('is true for a gated action step — needsApproval does not change what runs the step', () => {
    expect(
      nodeUsesModel({
        id: id(),
        name: 'Post it',
        instruction: [{ t: 'text', v: 'post' }],
        tool: 'jira_add_comment',
        maxAttempts: 1,
        failureHandling: [],
        needsApproval: true,
        approvalTimeoutHours: 96,
      })
    ).toBe(true);
  });

  it('is false for a terminal — deterministic, no model deciding', () => {
    expect(
      nodeUsesModel({
        id: id(),
        kind: 'terminal',
        name: 'End',
        result: 'success',
        message: [{ t: 'text', v: 'done' }],
      })
    ).toBe(false);
  });

  it('treats a v1 kind-less node as the action step it is', () => {
    // `action()` builds exactly that shape — no `kind`, as documents written
    // before nodes carried one still are.
    const legacy: AgentStepNode = action({ name: 'Old' });
    expect('kind' in legacy).toBe(false);
    expect(nodeUsesModel(legacy)).toBe(true);
  });
});
