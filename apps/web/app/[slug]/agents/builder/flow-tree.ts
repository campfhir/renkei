/**
 * Pure tree operations for the builder's step document. All functions are
 * immutable from React's point of view: they clone the tree, mutate the
 * clone, and return it — cheap at the platform's ≤20-node cap, and it keeps
 * the call sites as plain setState updaters.
 */

import {
  BRANCH_DEFAULT_ATTEMPTS,
  findNodeById,
  isBranchStep,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type BranchPath,
  type BranchStep,
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

/**
 * Where a node can be inserted: a position in the top-level list
 * (pathId null) or in a named branch path.
 */
export interface InsertLocation {
  pathId: string | null;
  index: number;
}

function clone(nodes: AgentStepNode[]): AgentStepNode[] {
  return structuredClone(nodes);
}

function listAt(nodes: AgentStepNode[], pathId: string | null): AgentStepNode[] | null {
  if (pathId === null) return nodes;
  for (const { node } of walkSteps(nodes)) {
    if (!isBranchStep(node)) continue;
    for (const path of node.paths) {
      if (path.id === pathId) return path.steps;
    }
  }
  return null;
}

export function insertNode(
  nodes: AgentStepNode[],
  location: InsertLocation,
  node: AgentStepNode
): AgentStepNode[] {
  const next = clone(nodes);
  const list = listAt(next, location.pathId);
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

/** The path object a location inserts into, for labels. */
export function pathOf(
  nodes: AgentStepNode[],
  pathId: string
): { branch: BranchStep; path: BranchPath } | null {
  for (const { node } of walkSteps(nodes)) {
    if (!isBranchStep(node)) continue;
    for (const path of node.paths) {
      if (path.id === pathId) return { branch: node, path };
    }
  }
  return null;
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
