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
  nodeUsesModel,
  requiredVersion,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type ApprovalStep,
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

  it('rejects a branch smuggled into a v1 document', () => {
    expect(isAgentStepsDoc({ version: 1, steps: [branch()] })).toBe(false);
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
    expect(isAgentStepsDoc(doc('continue'))).toBe(false);
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
    expect(isAgentStepsDoc({ version: 7, steps: [] })).toBe(false);
  });

  it('accepts an empty version-3 document shell', () => {
    expect(isAgentStepsDoc({ version: 3, steps: [] })).toBe(true);
  });

  it('admits terminal nodes only at version 4', () => {
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
    expect(isAgentStepsDoc({ version: 3, steps: [terminal] })).toBe(false);
    expect(isAgentStepsDoc({ version: 4, steps: [{ ...terminal, result: 'explode' }] })).toBe(
      false
    );
    expect(isAgentStepsDoc({ version: 4, steps: [{ ...terminal, notifyEmail: 'yes' }] })).toBe(
      false
    );
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

  it('requiredVersion: v1/v2 stay put, every v3 trigger bumps', () => {
    const { requiredVersion } = jest.requireActual<typeof import('./steps')>('./steps');
    expect(requiredVersion([action()])).toBe(1);
    expect(requiredVersion([branch()])).toBe(2);
    expect(requiredVersion([loop()])).toBe(3);
    expect(requiredVersion([group()])).toBe(3);
    expect(
      requiredVersion([
        branch({
          paths: [
            { id: randomUUID(), name: 'A', steps: [] },
            { id: randomUUID(), name: 'B', steps: [] },
            { id: randomUUID(), name: 'C', steps: [action()] },
          ],
        }),
      ])
    ).toBe(3);
    expect(
      requiredVersion([
        branch({ failurePath: { id: randomUUID(), name: 'On failure', steps: [] } }),
      ])
    ).toBe(3);
    // Three nested all-binary branches: no new constructs, but past the
    // frozen v2 depth — must be v3 or the v2 reader would reject it.
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
    expect(requiredVersion([threeDeep])).toBe(3);
  });

  it('the frozen v2 arm rejects every v3 construct', () => {
    expect(isAgentStepsDoc({ version: 2, steps: [loop()] })).toBe(false);
    expect(isAgentStepsDoc({ version: 2, steps: [group()] })).toBe(false);
    expect(
      isAgentStepsDoc({
        version: 2,
        steps: [branch({ failurePath: { id: randomUUID(), name: 'F', steps: [] } })],
      })
    ).toBe(false);
  });

  it('the v3 arm accepts the new constructs and enforces its own limits', () => {
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

  it('containsBranch sees nested branches', () => {
    expect(containsBranch([action()])).toBe(false);
    expect(containsBranch([action(), branch()])).toBe(true);
    expect(isBranchStep(branch())).toBe(true);
  });
});

describe('approval nodes (version 5)', () => {
  const approval = (overrides: Partial<ApprovalStep> = {}): ApprovalStep => ({
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
    ...overrides,
  });

  it('admits approval nodes only at version 5', () => {
    const node = approval();
    expect(isAgentStepsDoc({ version: 5, steps: [node] })).toBe(true);
    expect(isAgentStepsDoc({ version: 4, steps: [node] })).toBe(false);
    expect(isAgentStepsDoc({ version: 3, steps: [node] })).toBe(false);
    expect(isAgentStepsDoc({ version: 5, steps: [{ ...node, mode: 'shout' }] })).toBe(false);
    expect(isAgentStepsDoc({ version: 5, steps: [{ ...node, onTimeout: undefined }] })).toBe(false);
  });

  it('requiredVersion puts approval above terminal', () => {
    const terminal: TerminalStep = {
      id: randomUUID(),
      kind: 'terminal',
      name: 'Stop',
      result: 'stop',
      message: [],
      notifyEmail: false,
      notifyWebex: false,
    };
    expect(requiredVersion([approval()])).toBe(5);
    expect(
      requiredVersion([
        approval({ onDeclined: { id: randomUUID(), name: 'R', steps: [terminal] } }),
      ])
    ).toBe(5);
    expect(requiredVersion([terminal])).toBe(4);
  });

  it('walks and finds nodes inside outcome paths with the path grammar', () => {
    const inner: ActionStep = {
      id: randomUUID(),
      name: 'Send it',
      instruction: [{ t: 'text', v: 'send' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    };
    const node = approval({ onApproved: { id: randomUUID(), name: 'Approved', steps: [inner] } });
    const walked = walkSteps([node]);
    expect(walked.map((entry) => entry.path)).toEqual(['steps.0', 'steps.0.onApproved.steps.0']);

    const found = findNodeById([node], inner.id);
    expect(found?.ancestors).toHaveLength(1);
    const ancestor = found?.ancestors[0];
    expect(ancestor?.kind).toBe('approval');
    if (ancestor?.kind === 'approval') expect(ancestor.outcome).toBe('onApproved');
  });

  it('counts approval toward the branch nesting budget', () => {
    // approval > branch > branch > branch exceeds the 3-level branch cap.
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
    const tooDeep = approval({
      onApproved: {
        id: randomUUID(),
        name: 'Approved',
        steps: [deepBranch([deepBranch([deepBranch([])])])],
      },
    });
    expect(isAgentStepsDoc({ version: 5, steps: [tooDeep] })).toBe(false);
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

  it('is false for an approval', () => {
    expect(
      nodeUsesModel({
        id: id(),
        kind: 'approval',
        name: 'Ask',
        mode: 'approve',
        message: [{ t: 'text', v: 'ok?' }],
        timeoutHours: 24,
        onApproved: { id: id(), name: 'Approved', steps: [] },
        onDeclined: { id: id(), name: 'Declined', steps: [] },
        onTimeout: { id: id(), name: 'Timed out', steps: [] },
        notifyEmail: false,
        notifyWebex: false,
      })
    ).toBe(false);
  });

  it('is false for a terminal — it calls tools, but with no model deciding', () => {
    expect(
      nodeUsesModel({
        id: id(),
        kind: 'terminal',
        name: 'End',
        result: 'success',
        message: [{ t: 'text', v: 'done' }],
        notifyEmail: false,
        notifyWebex: false,
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
