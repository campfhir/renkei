/**
 * Editing an agent's steps without resending the whole document.
 *
 * `agent_update` takes a full definition and replaces what is stored. That is
 * the right primitive for a rewrite, and the wrong one for "add a step after
 * this one": the caller has to fetch the agent, echo every untouched node
 * back VERBATIM — same instruction tokens, same saveAs, same ids, because run
 * history and retry settings anchor to them — and a single transcription slip
 * silently rewrites a step nobody meant to touch. The larger the agent, the
 * likelier that is, which is exactly backwards.
 *
 * A patch names what changes and leaves everything else alone by construction.
 *
 * ## Where the tree surgery comes from
 *
 * `flow-tree.ts`, unchanged — the same `insertNode` / `updateNode` /
 * `removeNode` / `moveNodeTo` the builder's buttons call. It is pure (no
 * React, no 'use client'), so both surfaces share one implementation, and a
 * move refused in the UI is refused here for the same reason: `moveNodeTo`
 * returns the original array when a move is illegal, which is how the cycle
 * guard, the depth budgets and the loop-in-loop rule apply to MCP callers
 * without being restated.
 *
 * ## Anchors, not indices
 *
 * Positions are given as `after`/`before` another node wherever possible.
 * An index into a list a caller cannot see is a guess; a node id is
 * something `agent_get` just showed them. "Slot this between these two" is
 * the operation people actually want, and it should not require counting.
 */

import {
  CURRENT_STEPS_VERSION,
  findNodeById,
  isAgentStepsDoc,
  type AgentStepNode,
  type AgentStepsDoc,
} from '@renkei/agents';
import {
  bodyLocation,
  insertNode,
  moveNodeTo,
  pathLocation,
  removeNode,
  topLocation,
  updateNode,
  type InsertLocation,
} from '@/app/[slug]/agents/builder/flow-tree';

/** Where a node should land. Exactly one anchor, checked by the caller. */
export interface LocationSpec {
  /** Immediately after this node, in that node's own list. */
  after?: string;
  /** Immediately before this node, in that node's own list. */
  before?: string;
  /** Into a branch path, appended unless `index` says otherwise. */
  intoPath?: string;
  /** Into a loop or group body, appended unless `index` says otherwise. */
  intoContainer?: string;
  /** Onto the top-level list, appended unless `index` says otherwise. */
  atTop?: boolean;
  index?: number;
}

export type PatchOperation =
  | { op: 'insert'; node: AgentStepNode; at: LocationSpec }
  | { op: 'replace'; id: string; node: AgentStepNode }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; at: LocationSpec };

export type PatchResult = { ok: true; steps: AgentStepsDoc } | { ok: false; error: string };

/**
 * The list a node lives in, as an InsertLocation.
 *
 * Reads the node's innermost ancestor rather than searching the tree again:
 * `findNodeById` already walked it, and the ancestor chain says whether the
 * list is a branch path, a container body, or the top level.
 */
function locationOfList(
  nodes: AgentStepNode[],
  anchorId: string,
  offset: 0 | 1
): InsertLocation | null {
  const found = findNodeById(nodes, anchorId);
  if (!found) return null;
  const index = found.index + offset;
  const innermost = found.ancestors[found.ancestors.length - 1];
  if (!innermost) return topLocation(index);
  switch (innermost.kind) {
    case 'branch':
    case 'gate':
      return pathLocation(innermost.path.id, index);
    case 'loop':
      return bodyLocation(innermost.loop.id, index);
    case 'group':
      return bodyLocation(innermost.group.id, index);
    default: {
      const unhandled: never = innermost;
      throw new Error(`unknown ancestor kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** A LocationSpec resolved against the current tree, or why it cannot be. */
export function resolveLocation(
  nodes: AgentStepNode[],
  spec: LocationSpec
): { ok: true; location: InsertLocation } | { ok: false; error: string } {
  const anchors = [
    spec.after !== undefined,
    spec.before !== undefined,
    spec.intoPath !== undefined,
    spec.intoContainer !== undefined,
    spec.atTop === true,
  ].filter(Boolean).length;
  if (anchors === 0) {
    return {
      ok: false,
      error: 'a position is required: after, before, intoPath, intoContainer or atTop',
    };
  }
  if (anchors > 1) {
    return {
      ok: false,
      error: 'give exactly one of after, before, intoPath, intoContainer or atTop',
    };
  }

  if (spec.after !== undefined) {
    const location = locationOfList(nodes, spec.after, 1);
    return location
      ? { ok: true, location }
      : { ok: false, error: `no step with id "${spec.after}" to insert after` };
  }
  if (spec.before !== undefined) {
    const location = locationOfList(nodes, spec.before, 0);
    return location
      ? { ok: true, location }
      : { ok: false, error: `no step with id "${spec.before}" to insert before` };
  }
  // An explicit list: the index defaults to the end, which is what "into"
  // reads as when no position is named.
  const index = spec.index ?? Number.MAX_SAFE_INTEGER;
  if (spec.intoPath !== undefined)
    return { ok: true, location: pathLocation(spec.intoPath, index) };
  if (spec.intoContainer !== undefined) {
    return { ok: true, location: bodyLocation(spec.intoContainer, index) };
  }
  return { ok: true, location: topLocation(index) };
}

/**
 * Apply operations in order, stopping at the first that cannot be applied.
 *
 * All-or-nothing on purpose: a half-applied patch leaves an agent in a shape
 * its author never described and cannot easily reason about, and the caller
 * would have to diff to discover which operations took. Refusing the whole
 * patch keeps the failure legible.
 *
 * Later operations see earlier ones, so a caller can insert a step and then
 * move something into it in one call.
 */
export function applyStepPatch(steps: AgentStepsDoc, operations: PatchOperation[]): PatchResult {
  if (operations.length === 0) return { ok: false, error: 'no operations were given' };

  let nodes = steps.steps;
  for (const [ordinal, operation] of operations.entries()) {
    const label = `operation ${ordinal + 1} (${operation.op})`;
    switch (operation.op) {
      case 'insert': {
        const resolved = resolveLocation(nodes, operation.at);
        if (!resolved.ok) return { ok: false, error: `${label}: ${resolved.error}` };
        if (findNodeById(nodes, operation.node.id)) {
          return {
            ok: false,
            error:
              `${label}: id "${operation.node.id}" is already in this agent — ` +
              'a new step needs a fresh uuid, and changing an existing one is `replace`',
          };
        }
        const next = insertNode(nodes, resolved.location, operation.node);
        if (next === nodes) {
          return {
            ok: false,
            error:
              `${label}: that position does not exist, or the step cannot go there ` +
              '(a loop inside a loop, or past the nesting limit)',
          };
        }
        nodes = next;
        break;
      }
      case 'replace': {
        if (!findNodeById(nodes, operation.id)) {
          return { ok: false, error: `${label}: no step with id "${operation.id}"` };
        }
        if (operation.node.id !== operation.id) {
          // Run history, retry settings and trigger firings anchor to ids;
          // silently renaming one detaches an agent from its own past.
          return {
            ok: false,
            error:
              `${label}: the replacement's id must stay "${operation.id}" — ` +
              'moving a step is `move`, and a different step is `remove` plus `insert`',
          };
        }
        nodes = updateNode(nodes, operation.id, () => operation.node);
        break;
      }
      case 'remove': {
        if (!findNodeById(nodes, operation.id)) {
          return { ok: false, error: `${label}: no step with id "${operation.id}"` };
        }
        nodes = removeNode(nodes, operation.id);
        break;
      }
      case 'move': {
        if (!findNodeById(nodes, operation.id)) {
          return { ok: false, error: `${label}: no step with id "${operation.id}"` };
        }
        const resolved = resolveLocation(nodes, operation.at);
        if (!resolved.ok) return { ok: false, error: `${label}: ${resolved.error}` };
        const next = moveNodeTo(nodes, operation.id, resolved.location);
        if (next === nodes) {
          // moveNodeTo returns the original array for every refusal, so this
          // is the cycle guard, the depth budgets and loop-in-loop at once.
          return {
            ok: false,
            error:
              `${label}: that move is not allowed — a step cannot move inside itself, ` +
              'a loop cannot nest in a loop, and the branch/container depth limits apply',
          };
        }
        nodes = next;
        break;
      }
    }
  }

  return { ok: true, steps: { ...steps, steps: nodes } };
}

/**
 * A candidate node, narrowed by the real guard.
 *
 * `isNode` is internal to @renkei/agents, so the node is probed as a
 * one-node document — which is the same check the guard applies to every
 * node anyway, and avoids either a cast or a second, drifting copy of the
 * shape rules. Placement legality is NOT decided here: `insertNode` and
 * `moveNodeTo` own that.
 */
export function asStepNode(value: unknown): AgentStepNode | null {
  const probe = { version: CURRENT_STEPS_VERSION, steps: [value] };
  return isAgentStepsDoc(probe) ? (probe.steps[0] ?? null) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function locationSpecOf(value: unknown): LocationSpec {
  if (!isRecord(value)) return {};
  const text = (key: string): string | undefined =>
    typeof value[key] === 'string' && value[key] ? value[key] : undefined;
  return {
    ...(text('after') !== undefined ? { after: text('after') } : {}),
    ...(text('before') !== undefined ? { before: text('before') } : {}),
    ...(text('intoPath') !== undefined ? { intoPath: text('intoPath') } : {}),
    ...(text('intoContainer') !== undefined ? { intoContainer: text('intoContainer') } : {}),
    ...(value.atTop === true ? { atTop: true } : {}),
    ...(typeof value.index === 'number' ? { index: value.index } : {}),
  };
}

/**
 * Wire operations into typed ones, refusing anything malformed by NAME —
 * "operation 2 (move): id is required" beats a schema dump for a caller
 * assembling these from an agent_get listing.
 */
export function toPatchOperations(value: unknown): { val: PatchOperation[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'operations must be a non-empty array' };
  }
  const out: PatchOperation[] = [];
  for (const [ordinal, raw] of value.entries()) {
    const label = `operation ${ordinal + 1}`;
    if (!isRecord(raw)) return { error: `${label}: not an object` };
    const op = raw.op;
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    const at = locationSpecOf(raw.at);

    if (op === 'insert' || op === 'replace') {
      const node = asStepNode(raw.node);
      if (!node) {
        return {
          error:
            `${label} (${op}): node is missing or is not a valid step — ` +
            'send the same shape agent_get returns',
        };
      }
      if (op === 'insert') out.push({ op, node, at });
      else {
        if (!id) return { error: `${label} (replace): id is required` };
        out.push({ op, id, node });
      }
      continue;
    }
    if (op === 'remove' || op === 'move') {
      if (!id) return { error: `${label} (${op}): id is required` };
      if (op === 'remove') out.push({ op, id });
      else out.push({ op, id, at });
      continue;
    }
    return { error: `${label}: op must be insert, replace, remove or move` };
  }
  return { val: out };
}
