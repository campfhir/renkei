/**
 * The builder's tree ops: inserting into every list kind, the move-to
 * guards (cycle, depth budget, loop-in-loop), and issue-to-node routing.
 */

import type { ActionStep, AgentStepNode, BranchStep, GroupStep, LoopStep } from '@renkei/agents';
import {
  bodyLocation,
  insertNode,
  listAtLocation,
  moveNodeTo,
  moveTargets,
  newGroup,
  newLoop,
  pathLocation,
  topLocation,
  issuesByNode,
} from './flow-tree';

function action(id: string, name = id): ActionStep {
  return { id, name, instruction: [], tool: null, maxAttempts: 2, failureHandling: [] };
}

function branch(
  id: string,
  paths: { id: string; name: string; steps: AgentStepNode[] }[],
  failurePath?: { id: string; name: string; steps: AgentStepNode[] }
): BranchStep {
  return {
    id,
    kind: 'branch',
    name: `branch ${id}`,
    condition: [{ t: 'text', v: 'is it?' }],
    paths,
    ...(failurePath ? { failurePath } : {}),
    maxAttempts: 2,
  };
}

function loop(id: string, steps: AgentStepNode[]): LoopStep {
  return {
    id,
    kind: 'loop',
    mode: 'foreach',
    name: `loop ${id}`,
    itemsVar: 'items',
    itemVar: 'item',
    maxIterations: 5,
    steps,
  };
}

function group(id: string, steps: AgentStepNode[]): GroupStep {
  return { id, kind: 'group', name: `group ${id}`, steps };
}

/**
 * top: a1, branch B (path P1: [a2], path P2: [], failurePath F: []),
 * loop L: [a3], group G: [a4]
 */
function fixture(): AgentStepNode[] {
  return [
    action('a1'),
    branch(
      'B',
      [
        { id: 'P1', name: 'If so', steps: [action('a2')] },
        { id: 'P2', name: 'Otherwise', steps: [] },
      ],
      { id: 'F', name: 'On failure', steps: [] }
    ),
    loop('L', [action('a3')]),
    group('G', [action('a4')]),
  ];
}

describe('listAtLocation / insertNode', () => {
  it('resolves the top level, branch paths, the failure path, and container bodies', () => {
    const nodes = fixture();
    expect(listAtLocation(nodes, topLocation(0))).toBe(nodes);
    expect(listAtLocation(nodes, pathLocation('P1', 0))?.[0]?.id).toBe('a2');
    expect(listAtLocation(nodes, pathLocation('F', 0))).toEqual([]);
    expect(listAtLocation(nodes, bodyLocation('L', 0))?.[0]?.id).toBe('a3');
    expect(listAtLocation(nodes, bodyLocation('G', 0))?.[0]?.id).toBe('a4');
    expect(listAtLocation(nodes, pathLocation('nope', 0))).toBeNull();
    expect(listAtLocation(nodes, bodyLocation('a1', 0))).toBeNull();
  });

  it('inserts into each slot kind without touching the original', () => {
    const nodes = fixture();
    const intoTop = insertNode(nodes, topLocation(1), action('n1'));
    expect(intoTop[1]?.id).toBe('n1');
    expect(nodes[1]?.id).toBe('B');

    const intoPath = insertNode(nodes, pathLocation('P2', 0), action('n2'));
    const p2 = listAtLocation(intoPath, pathLocation('P2', 0));
    expect(p2?.map((n) => n.id)).toEqual(['n2']);

    const intoFailure = insertNode(nodes, pathLocation('F', 0), action('n3'));
    expect(listAtLocation(intoFailure, pathLocation('F', 0))?.map((n) => n.id)).toEqual(['n3']);

    const intoLoop = insertNode(nodes, bodyLocation('L', 99), action('n4'));
    expect(listAtLocation(intoLoop, bodyLocation('L', 0))?.map((n) => n.id)).toEqual(['a3', 'n4']);
  });
});

describe('moveNodeTo', () => {
  it('moves a node between lists', () => {
    const nodes = fixture();
    const moved = moveNodeTo(nodes, 'a1', pathLocation('P2', 0));
    expect(moved).not.toBe(nodes);
    expect(moved[0]?.id).toBe('B');
    expect(listAtLocation(moved, pathLocation('P2', 0))?.map((n) => n.id)).toEqual(['a1']);
  });

  it('refuses to move a container into its own subtree', () => {
    const nodes = fixture();
    expect(moveNodeTo(nodes, 'B', pathLocation('P1', 0))).toBe(nodes);
    expect(moveNodeTo(nodes, 'L', bodyLocation('L', 0))).toBe(nodes);
  });

  it('refuses a loop inside a loop', () => {
    const nodes = fixture();
    // Standalone loop moved into L's body — nested loops are banned.
    const other = [...nodes, loop('L2', [])];
    expect(moveNodeTo(other, 'L2', bodyLocation('L', 0))).toBe(other);
    // But into a group it may go.
    const intoGroup = moveNodeTo(other, 'L2', bodyLocation('G', 99));
    expect(intoGroup).not.toBe(other);
    expect(listAtLocation(intoGroup, bodyLocation('G', 0))?.map((n) => n.id)).toEqual(['a4', 'L2']);
  });

  it('enforces the branch-depth budget', () => {
    // A branch holding a branch (internal depth 2) may enter a depth-1 path
    // (total 3) but not a depth-2 one (total 4 > 3).
    const inner = branch('B3', [
      { id: 'P5', name: 'a', steps: [] },
      { id: 'P6', name: 'b', steps: [] },
    ]);
    const nested = branch('B2', [
      { id: 'P3', name: 'a', steps: [inner] },
      { id: 'P4', name: 'b', steps: [] },
    ]);
    const host = branch('H1', [
      {
        id: 'HP1',
        name: 'depth 1',
        steps: [
          branch('H2', [
            { id: 'HP2', name: 'depth 2', steps: [] },
            { id: 'HP3', name: 'other', steps: [] },
          ]),
        ],
      },
      { id: 'HP4', name: 'other', steps: [] },
    ]);
    const nodes: AgentStepNode[] = [host, nested];
    expect(moveNodeTo(nodes, 'B2', pathLocation('HP1', 99))).not.toBe(nodes);
    expect(moveNodeTo(nodes, 'B2', pathLocation('HP2', 0))).toBe(nodes);
  });

  it('counts loops against the container budget but not groups', () => {
    // Loop > branch > branch > branch is depth 4 — at the ceiling. Wrapping
    // one more branch level around the destination must overflow.
    const deep = branch('D1', [
      {
        id: 'DP1',
        name: 'a',
        steps: [
          branch('D2', [
            { id: 'DP2', name: 'b', steps: [] },
            { id: 'DP3', name: 'c', steps: [] },
          ]),
        ],
      },
      { id: 'DP4', name: 'd', steps: [] },
    ]);
    const nodes: AgentStepNode[] = [loop('L1', []), group('G1', [loop('L2', [])]), deep];
    // branchDepth 2, containerDepth 2 moved into a loop (container 1) = 3 ≤ 4.
    expect(moveNodeTo(nodes, 'D1', bodyLocation('L1', 0))).not.toBe(nodes);
    // Same move into a loop inside a group: group is free, still legal.
    expect(moveNodeTo(nodes, 'D1', bodyLocation('L2', 0))).not.toBe(nodes);
  });
});

describe('moveTargets', () => {
  it('lists legal destinations, excluding the current list', () => {
    const nodes = fixture();
    const labels = moveTargets(nodes, 'a1').map((t) => t.label);
    expect(labels).not.toContain('Top level');
    expect(labels).toEqual(
      expect.arrayContaining([
        'Path "If so" of "branch B"',
        'Path "Otherwise" of "branch B"',
        'Failure path of "branch B"',
        'Loop "loop L"',
        'Group "group G"',
      ])
    );
  });

  it('omits destinations inside the moved node and loop-in-loop targets', () => {
    const nodes = fixture();
    const branchTargets = moveTargets(nodes, 'B').map((t) => t.label);
    expect(branchTargets).not.toContain('Path "If so" of "branch B"');
    expect(branchTargets).not.toContain('Failure path of "branch B"');
    expect(branchTargets).toContain('Loop "loop L"');

    const loopTargets = moveTargets(nodes, 'L').map((t) => t.label);
    expect(loopTargets).not.toContain('Loop "loop L"');
    expect(loopTargets).toContain('Group "group G"');
  });

  it('hands out end-of-list indices that survive the removal', () => {
    const nodes = fixture();
    const target = moveTargets(nodes, 'a1').find((t) => t.label === 'Group "group G"');
    expect(target).toBeDefined();
    const moved = moveNodeTo(nodes, 'a1', target!.location);
    expect(listAtLocation(moved, bodyLocation('G', 0))?.map((n) => n.id)).toEqual(['a4', 'a1']);
  });
});

describe('issuesByNode', () => {
  it('routes issues to the deepest owning node across container kinds', () => {
    const nodes = fixture();
    const routed = issuesByNode(nodes, [
      { path: 'steps.0.name', message: 'top step name' },
      { path: 'steps.1.paths.0.steps.0.instruction', message: 'nested action' },
      { path: 'steps.1.failurePath.name', message: 'failure path name' },
      { path: 'steps.2.itemsVar', message: 'loop items' },
      { path: 'steps.2.steps.0.name', message: 'loop body step' },
      { path: 'steps.3.steps.0.name', message: 'group body step' },
      { path: 'name', message: 'not a node issue' },
    ]);
    expect(routed.get('a1')).toEqual(['top step name']);
    expect(routed.get('a2')).toEqual(['nested action']);
    expect(routed.get('B')).toEqual(['failure path name']);
    expect(routed.get('L')).toEqual(['loop items']);
    expect(routed.get('a3')).toEqual(['loop body step']);
    expect(routed.get('a4')).toEqual(['group body step']);
    expect([...routed.values()].flat()).not.toContain('not a node issue');
  });
});

describe('factories', () => {
  it('newLoop and newGroup produce empty, insertable containers', () => {
    const loopNode = newLoop();
    expect(loopNode.kind).toBe('loop');
    expect(loopNode.mode).toBe('foreach');
    expect(loopNode.steps).toEqual([]);
    const groupNode = newGroup();
    expect(groupNode.kind).toBe('group');
    expect(groupNode.steps).toEqual([]);
    const nodes = insertNode(fixture(), topLocation(0), loopNode);
    expect(nodes[0]?.id).toBe(loopNode.id);
  });
});
