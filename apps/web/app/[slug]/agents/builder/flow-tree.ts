/**
 * Pure tree operations for the builder's step document. All functions are
 * immutable from React's point of view: they clone the tree, mutate the
 * clone, and return it — cheap at the platform's ≤20-node cap, and it keeps
 * the call sites as plain setState updaters.
 */

import {
  APPROVAL_DEFAULT_TIMEOUT_HOURS,
  BRANCH_DEFAULT_ATTEMPTS,
  LOOP_DEFAULT_ITERATIONS,
  MAX_BRANCH_DEPTH_V3,
  MAX_CONTAINER_DEPTH,
  approvalPathsOf,
  findNodeById,
  isApprovalStep,
  isBranchStep,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type ApprovalStep,
  type BranchPath,
  type BranchStep,
  type ForEachLoopStep,
  type GroupStep,
  type TerminalStep,
  type ValidationIssue,
} from '@renkei/agents';
import { randomUUID } from '@/lib/agents/uuid';

export function newStep(attemptsCap: number): ActionStep {
  return {
    id: randomUUID(),
    name: '',
    instruction: [],
    tool: null,
    // 5 tries by default; a stricter org cap wins.
    maxAttempts: Math.min(5, attemptsCap),
    failureHandling: [],
  };
}

export function newBranch(): BranchStep {
  return {
    id: randomUUID(),
    kind: 'branch',
    name: '',
    condition: [],
    paths: [
      { id: randomUUID(), name: 'If so', steps: [] },
      { id: randomUUID(), name: 'Otherwise', steps: [] },
    ],
    maxAttempts: BRANCH_DEFAULT_ATTEMPTS,
  };
}

export function newLoop(): ForEachLoopStep {
  return {
    id: randomUUID(),
    kind: 'loop',
    mode: 'foreach',
    name: '',
    itemsVar: '',
    itemVar: 'item',
    maxIterations: LOOP_DEFAULT_ITERATIONS,
    steps: [],
  };
}

export function newGroup(): GroupStep {
  return {
    id: randomUUID(),
    kind: 'group',
    name: '',
    steps: [],
  };
}

export function newApproval(): ApprovalStep {
  return {
    id: randomUUID(),
    kind: 'approval',
    name: '',
    message: [],
    mode: 'approve',
    timeoutHours: APPROVAL_DEFAULT_TIMEOUT_HOURS,
    notifyEmail: true,
    notifyWebex: false,
    onApproved: { id: randomUUID(), name: 'Approved', steps: [] },
    onDeclined: { id: randomUUID(), name: 'Declined', steps: [] },
    onTimeout: { id: randomUUID(), name: 'No answer in time', steps: [] },
  };
}

export function newTerminal(): TerminalStep {
  return {
    id: randomUUID(),
    kind: 'terminal',
    name: '',
    // A fresh end marker reads as "finish here"; the editor flips it to a
    // failure or skip ending when that's what it marks.
    result: 'success',
    message: [],
    notifyEmail: false,
    notifyWebex: false,
  };
}

/**
 * Where a node can be inserted. Three list kinds exist in a v3 document:
 * the top level (`containerId: null`), a branch path — logical or failure,
 * both are BranchPath objects with doc-unique ids (`slot: 'path'`,
 * containerId = the PATH's id) — and a loop/group body (`slot: 'body'`,
 * containerId = the container NODE's id).
 */
export type InsertLocation =
  | { containerId: null; slot: null; index: number }
  | { containerId: string; slot: 'path' | 'body'; index: number };

export function topLocation(index: number): InsertLocation {
  return { containerId: null, slot: null, index };
}

export function pathLocation(pathId: string, index: number): InsertLocation {
  return { containerId: pathId, slot: 'path', index };
}

export function bodyLocation(containerId: string, index: number): InsertLocation {
  return { containerId, slot: 'body', index };
}

function clone(nodes: AgentStepNode[]): AgentStepNode[] {
  return structuredClone(nodes);
}

/** One path-shaped child list: a branch route, a failure route, or an approval outcome. */
interface PathEntry {
  /** The owning NODE's id (branch or approval) — nesting context anchor. */
  ownerId: string;
  path: BranchPath;
  /** Move-menu label, e.g. `Path "A ticket exists" of "Triage"`. */
  label: string;
}

/** Every BranchPath in the tree — branch routes, failure routes, approval outcomes. */
function allPaths(nodes: AgentStepNode[]): PathEntry[] {
  const out: PathEntry[] = [];
  for (const { node } of walkSteps(nodes)) {
    if (isBranchStep(node)) {
      const branchName = displayName(node.name, 'branch');
      for (const path of node.paths) {
        out.push({
          ownerId: node.id,
          path,
          label: `Path "${displayName(path.name, 'path')}" of "${branchName}"`,
        });
      }
      if (node.failurePath) {
        out.push({
          ownerId: node.id,
          path: node.failurePath,
          label: `Failure path of "${branchName}"`,
        });
      }
    } else if (isApprovalStep(node)) {
      const approvalName = displayName(node.name, 'approval');
      for (const { key, path } of approvalPathsOf(node)) {
        const what =
          key === 'onApproved' ? 'Approved' : key === 'onDeclined' ? 'Declined' : 'Timed-out';
        out.push({ ownerId: node.id, path, label: `${what} path of "${approvalName}"` });
      }
    }
  }
  return out;
}

/** The mutable child list a location points into, or null if it's gone. */
export function listAtLocation(
  nodes: AgentStepNode[],
  location: InsertLocation
): AgentStepNode[] | null {
  if (location.containerId === null) return nodes;
  if (location.slot === 'path') {
    const owner = allPaths(nodes).find(({ path }) => path.id === location.containerId);
    return owner ? owner.path.steps : null;
  }
  const found = findNodeById(nodes, location.containerId);
  if (!found) return null;
  const node = found.node;
  return node.kind === 'loop' || node.kind === 'group' ? node.steps : null;
}

export function insertNode(
  nodes: AgentStepNode[],
  location: InsertLocation,
  node: AgentStepNode
): AgentStepNode[] {
  const next = clone(nodes);
  const list = listAtLocation(next, location);
  if (!list) return next;
  list.splice(Math.max(0, Math.min(location.index, list.length)), 0, node);
  return next;
}

export function updateNode(
  nodes: AgentStepNode[],
  id: string,
  updater: (node: AgentStepNode) => AgentStepNode
): AgentStepNode[] {
  const next = clone(nodes);
  const found = findNodeById(next, id);
  if (!found) return next;
  found.siblings[found.index] = updater(found.node);
  return next;
}

export function removeNode(nodes: AgentStepNode[], id: string): AgentStepNode[] {
  const next = clone(nodes);
  const found = findNodeById(next, id);
  if (!found) return next;
  found.siblings.splice(found.index, 1);
  return next;
}

/** Swap a node with its sibling; a move off either end is a no-op. */
export function moveSibling(
  nodes: AgentStepNode[],
  id: string,
  direction: -1 | 1
): AgentStepNode[] {
  const next = clone(nodes);
  const found = findNodeById(next, id);
  if (!found) return next;
  const target = found.index + direction;
  if (target < 0 || target >= found.siblings.length) return nodes;
  [found.siblings[found.index], found.siblings[target]] = [
    found.siblings[target],
    found.siblings[found.index],
  ];
  return next;
}

/** The path entry a location inserts into, for labels and owner lookups. */
export function pathOf(nodes: AgentStepNode[], pathId: string): PathEntry | null {
  return allPaths(nodes).find(({ path }) => path.id === pathId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Move-to: relocating a node across lists, with the same structural  */
/* guards the schema enforces so the menu can never build an invalid  */
/* document.                                                          */
/* ------------------------------------------------------------------ */

/** What the moved subtree itself contributes to nesting budgets. */
interface SubtreeMetrics {
  /** Deepest chain of branches inside (counting the node itself). */
  branchDepth: number;
  /** Deepest chain of branch+loop containers inside (groups free). */
  containerDepth: number;
  hasLoop: boolean;
}

function subtreeMetrics(node: AgentStepNode): SubtreeMetrics {
  const ofList = (list: AgentStepNode[]): SubtreeMetrics => {
    let branchDepth = 0;
    let containerDepth = 0;
    let hasLoop = false;
    for (const child of list) {
      const m = subtreeMetrics(child);
      branchDepth = Math.max(branchDepth, m.branchDepth);
      containerDepth = Math.max(containerDepth, m.containerDepth);
      hasLoop = hasLoop || m.hasLoop;
    }
    return { branchDepth, containerDepth, hasLoop };
  };
  switch (node.kind) {
    case 'branch': {
      const lists = [...node.paths.map((path) => path.steps)];
      if (node.failurePath) lists.push(node.failurePath.steps);
      const inner = lists.map(ofList).reduce(
        (a, b) => ({
          branchDepth: Math.max(a.branchDepth, b.branchDepth),
          containerDepth: Math.max(a.containerDepth, b.containerDepth),
          hasLoop: a.hasLoop || b.hasLoop,
        }),
        { branchDepth: 0, containerDepth: 0, hasLoop: false }
      );
      return {
        branchDepth: inner.branchDepth + 1,
        containerDepth: inner.containerDepth + 1,
        hasLoop: inner.hasLoop,
      };
    }
    case 'loop': {
      const inner = ofList(node.steps);
      return {
        branchDepth: inner.branchDepth,
        containerDepth: inner.containerDepth + 1,
        hasLoop: true,
      };
    }
    case 'group':
      // Depth-neutral, same as the schema's guards.
      return ofList(node.steps);
    case 'approval': {
      // Branch-like: the outcome paths consume a branch level and a
      // container level, same as a BranchStep.
      const inner = approvalPathsOf(node)
        .map(({ path }) => ofList(path.steps))
        .reduce(
          (a, b) => ({
            branchDepth: Math.max(a.branchDepth, b.branchDepth),
            containerDepth: Math.max(a.containerDepth, b.containerDepth),
            hasLoop: a.hasLoop || b.hasLoop,
          }),
          { branchDepth: 0, containerDepth: 0, hasLoop: false }
        );
      return {
        branchDepth: inner.branchDepth + 1,
        containerDepth: inner.containerDepth + 1,
        hasLoop: inner.hasLoop,
      };
    }
    case 'terminal':
    case 'action':
    case undefined:
      return { branchDepth: 0, containerDepth: 0, hasLoop: false };
    default: {
      const unhandled: never = node;
      throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Nesting already surrounding a location's list. */
interface LocationContext {
  branchDepth: number;
  containerDepth: number;
  inLoop: boolean;
  /** Node ids on the way down — a location inside X has X's id here. */
  ancestorIds: string[];
}

function contextOfLocation(
  nodes: AgentStepNode[],
  location: InsertLocation
): LocationContext | null {
  if (location.containerId === null) {
    return { branchDepth: 0, containerDepth: 0, inLoop: false, ancestorIds: [] };
  }
  const ownerId =
    location.slot === 'path'
      ? (pathOf(nodes, location.containerId)?.ownerId ?? null)
      : location.containerId;
  if (ownerId === null) return null;
  const found = findNodeById(nodes, ownerId);
  if (!found) return null;
  const context: LocationContext = {
    branchDepth: 0,
    containerDepth: 0,
    inLoop: false,
    ancestorIds: [],
  };
  const enter = (node: AgentStepNode) => {
    context.ancestorIds.push(node.id);
    switch (node.kind) {
      case 'branch':
      case 'approval':
        context.branchDepth += 1;
        context.containerDepth += 1;
        break;
      case 'loop':
        context.containerDepth += 1;
        context.inLoop = true;
        break;
      case 'group':
      case 'terminal':
      case 'action':
      case undefined:
        break;
      default: {
        const unhandled: never = node;
        throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  };
  for (const ancestor of found.ancestors) {
    switch (ancestor.kind) {
      case 'branch':
        enter(ancestor.branch);
        break;
      case 'loop':
        enter(ancestor.loop);
        break;
      case 'group':
        enter(ancestor.group);
        break;
      case 'approval':
        enter(ancestor.approval);
        break;
      default: {
        const unhandled: never = ancestor;
        throw new Error(`unknown ancestor kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  // The list is INSIDE the owning container, so the owner counts too.
  enter(found.node);
  return context;
}

function moveIsLegal(
  nodes: AgentStepNode[],
  node: AgentStepNode,
  location: InsertLocation
): boolean {
  const context = contextOfLocation(nodes, location);
  if (!context) return false;
  // Cycle guard: a location inside the moved subtree lists the node itself
  // among its ancestors.
  if (context.ancestorIds.includes(node.id)) return false;
  const metrics = subtreeMetrics(node);
  if (context.branchDepth + metrics.branchDepth > MAX_BRANCH_DEPTH_V3) return false;
  if (context.containerDepth + metrics.containerDepth > MAX_CONTAINER_DEPTH) return false;
  if (context.inLoop && metrics.hasLoop) return false;
  return true;
}

/**
 * Move a node to another list. Returns the ORIGINAL array when the move is
 * illegal (cycle, depth budget, loop-in-loop) or the location has vanished,
 * so callers can treat identity as "nothing happened". The index is clamped
 * after removal — moveTargets hands out end-of-list indices, which stay
 * correct whichever list the node left.
 */
export function moveNodeTo(
  nodes: AgentStepNode[],
  id: string,
  location: InsertLocation
): AgentStepNode[] {
  const source = findNodeById(nodes, id);
  if (!source) return nodes;
  if (!moveIsLegal(nodes, source.node, location)) return nodes;
  const next = clone(nodes);
  const found = findNodeById(next, id);
  if (!found) return nodes;
  const [node] = found.siblings.splice(found.index, 1);
  const list = listAtLocation(next, location);
  if (!list) return nodes;
  list.splice(Math.max(0, Math.min(location.index, list.length)), 0, node);
  return next;
}

export interface MoveTarget {
  location: InsertLocation;
  /** Menu label, e.g. `Path "A ticket exists" of "Triage"`. */
  label: string;
}

function displayName(name: string, fallback: string): string {
  return name.trim() || fallback;
}

/**
 * Every list the node may legally move to, current list excluded (ordering
 * within a list is the Up/Down buttons' job). Indices point at the end of
 * each target list.
 */
export function moveTargets(nodes: AgentStepNode[], id: string): MoveTarget[] {
  const found = findNodeById(nodes, id);
  if (!found) return [];
  const candidates: { location: InsertLocation; label: string; list: AgentStepNode[] }[] = [
    { location: topLocation(nodes.length), label: 'Top level', list: nodes },
  ];
  for (const { path, label } of allPaths(nodes)) {
    candidates.push({
      location: pathLocation(path.id, path.steps.length),
      label,
      list: path.steps,
    });
  }
  for (const { node } of walkSteps(nodes)) {
    if (node.kind === 'loop') {
      candidates.push({
        location: bodyLocation(node.id, node.steps.length),
        label: `Loop "${displayName(node.name, 'loop')}"`,
        list: node.steps,
      });
    } else if (node.kind === 'group') {
      candidates.push({
        location: bodyLocation(node.id, node.steps.length),
        label: `Group "${displayName(node.name, 'group')}"`,
        list: node.steps,
      });
    }
  }
  return candidates
    .filter(({ list }) => list !== found.siblings)
    .filter(({ location }) => moveIsLegal(nodes, found.node, location))
    .map(({ location, label }) => ({ location, label }));
}

/**
 * Assign validation issues to nodes by LONGEST matching path prefix, so a
 * nested step owns its own problems and the enclosing branch owns only what
 * is genuinely its own (`…condition`, `…paths.0.name`). Issues at bare
 * `steps`, `name`, or `triggers*` belong to no node and are not returned.
 */
export function issuesByNode(
  nodes: AgentStepNode[],
  issues: ValidationIssue[]
): Map<string, string[]> {
  const prefixes = walkSteps(nodes)
    .map(({ node, path }) => ({ id: node.id, prefix: path }))
    // Longest first: the first prefix that matches IS the longest match.
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const out = new Map<string, string[]>();
  for (const issue of issues) {
    const owner = prefixes.find(
      ({ prefix }) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)
    );
    if (!owner) continue;
    const list = out.get(owner.id) ?? [];
    list.push(issue.message);
    out.set(owner.id, list);
  }
  return out;
}
