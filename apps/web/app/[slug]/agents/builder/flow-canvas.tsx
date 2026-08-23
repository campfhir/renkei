'use client';

/**
 * The flow chart: trigger cluster at the top, nodes joined by connector
 * lines, containers (loops, groups) drawn as bordered boxes around their
 * bodies, and EVERY branch as a vertical RouterBlock of labeled route rows
 * — one rendering at every width and path count, which keeps the canvas a
 * single readable column on phone and desktop alike and stops nesting from
 * growing it sideways. Reading it IS reading the recipe; editing happens
 * in the panel that opens when a node is selected.
 *
 * Every connector carries an always-visible "+" (mobile has no hover) that
 * opens an insert menu — step, branch, loop, group, each offered only where
 * the document's nesting rules allow it — inserting at that exact edge.
 * Containers past depth 1 fold by default; every container can be "opened"
 * (breadcrumb drill-in) to edit a deep region without the surroundings.
 */

import { useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from 'react';
import {
  findNodeById,
  MAX_BRANCH_DEPTH_V3,
  MAX_CONTAINER_DEPTH,
  type AgentStepNode,
  type BranchPath,
  type BranchStep,
  type FoundAncestor,
  type GroupStep,
  type LoopStep,
} from '@renkei/agents';
import {
  bodyLocation,
  pathLocation,
  topLocation,
  type InsertLocation,
  type MoveTarget,
} from './flow-tree';
import type { AgentChoice, BuilderTrigger } from './trigger-node';
import { TriggerNode } from './trigger-node';
import { StepNode } from './step-node';
import { BranchNode } from './branch-node';
import { LoopNode } from './loop-node';
import { GroupNode } from './group-node';
import { TerminalNode } from './terminal-node';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';

export type BuilderSelection =
  { type: 'step'; id: string } | { type: 'trigger'; index: number } | { type: 'new-trigger' };

export type InsertKind = 'step' | 'branch' | 'loop' | 'group' | 'terminal';

interface CanvasHandlers {
  selection: BuilderSelection | null;
  issuesFor: (nodeId: string) => number;
  onSelect: (selection: BuilderSelection | null) => void;
  onInsert: (location: InsertLocation, kind: InsertKind) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDelete: (id: string) => void;
  moveTargetsFor: (id: string) => MoveTarget[];
  onMoveTo: (id: string, location: InsertLocation) => void;
  /** Effective expansion for a container, given its situational default. */
  isExpanded: (id: string, defaultExpanded: boolean) => boolean;
  onToggleExpand: (id: string, defaultExpanded: boolean) => void;
  onOpen: (id: string) => void;
}

/** Structural context of the LIST being rendered (not of a node). */
interface Nesting {
  branchDepth: number;
  containerDepth: number;
  inLoop: boolean;
  /** Display depth: 1 at the spine, +1 inside any container (groups too). */
  display: number;
}

const TOP_NESTING: Nesting = { branchDepth: 0, containerDepth: 0, inLoop: false, display: 1 };

function nestingOfAncestors(ancestors: FoundAncestor[]): Nesting {
  const nesting = { ...TOP_NESTING };
  for (const ancestor of ancestors) {
    nesting.display += 1;
    switch (ancestor.kind) {
      case 'branch':
        nesting.branchDepth += 1;
        nesting.containerDepth += 1;
        break;
      case 'loop':
        nesting.containerDepth += 1;
        nesting.inLoop = true;
        break;
      case 'group':
        break;
      default: {
        const unhandled: never = ancestor;
        throw new Error(`unknown ancestor kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  return nesting;
}

function Connector({
  location,
  nesting,
  onInsert,
}: {
  location: InsertLocation;
  nesting: Nesting;
  onInsert: CanvasHandlers['onInsert'];
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Clicking anywhere else (or Escape) cancels the add — each connector owns
  // its own popup, so without this they only closed by re-clicking their "+".
  useDismiss(open, menuRef, () => setOpen(false));
  const allowBranch =
    nesting.branchDepth < MAX_BRANCH_DEPTH_V3 && nesting.containerDepth < MAX_CONTAINER_DEPTH;
  const allowLoop = !nesting.inLoop && nesting.containerDepth < MAX_CONTAINER_DEPTH;
  const item = (label: string, kind: InsertKind, icon: string, iconClass: string) => (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        onInsert(location, kind);
      }}
      className="flex items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
    >
      <Icon path={icon} className={`h-4 w-4 ${iconClass}`} />
      {label}
    </button>
  );
  return (
    <div ref={menuRef} className="relative flex h-9 flex-col items-center">
      <span aria-hidden="true" className="h-full w-px bg-gray-300 dark:bg-gray-700" />
      <button
        type="button"
        aria-label="Add here"
        title="Add a step, branch, loop, or group here"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="absolute top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-gray-300 bg-white text-xs leading-none text-gray-400 hover:border-blue-500 hover:text-blue-600 dark:border-gray-700 dark:bg-gray-950 dark:hover:border-blue-400"
      >
        +
      </button>
      {open ? (
        <div className="absolute left-1/2 top-1/2 z-20 ml-4 flex w-max -translate-y-1/2 flex-col overflow-hidden rounded-md border border-gray-200 bg-white text-left shadow-lg dark:border-gray-700 dark:bg-gray-950">
          {item('Add a step', 'step', ICONS.step, 'text-gray-400')}
          {allowBranch ? item('Add a branch', 'branch', ICONS.branch, 'text-indigo-500') : null}
          {allowLoop ? item('Add a loop', 'loop', ICONS.loop, 'text-amber-500') : null}
          {item('Add a group', 'group', ICONS.group, 'text-slate-400')}
          {item('End the run here', 'terminal', ICONS.terminal, 'text-rose-500')}
        </div>
      ) : null}
    </div>
  );
}

function nodeNoun(node: AgentStepNode): string {
  switch (node.kind) {
    case 'branch':
      return 'branch';
    case 'loop':
      return 'loop';
    case 'group':
      return 'group';
    case 'terminal':
      return 'ending';
    case 'action':
    case undefined:
      return 'step';
    default: {
      const unhandled: never = node;
      throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

function NodeControls({
  node,
  index,
  count,
  handlers,
}: {
  node: AgentStepNode;
  index: number;
  count: number;
  handlers: CanvasHandlers;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  const targets = menuOpen ? handlers.moveTargetsFor(node.id) : [];
  return (
    <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
      <button
        type="button"
        aria-label="Move up"
        disabled={index === 0}
        onClick={() => handlers.onMove(node.id, -1)}
        className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-gray-800 disabled:opacity-30 dark:border-gray-800 dark:hover:text-gray-200"
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Move down"
        disabled={index === count - 1}
        onClick={() => handlers.onMove(node.id, 1)}
        className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-gray-800 disabled:opacity-30 dark:border-gray-800 dark:hover:text-gray-200"
      >
        ↓
      </button>
      <div ref={menuRef} className="relative">
        <button
          type="button"
          aria-label={`Move ${nodeNoun(node)} to another list`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
          className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-gray-800 dark:border-gray-800 dark:hover:text-gray-200"
        >
          Move to…
        </button>
        {menuOpen ? (
          <div className="absolute left-0 top-full z-20 mt-1 flex max-h-64 w-max max-w-72 flex-col overflow-y-auto rounded-md border border-gray-200 bg-white text-left shadow-lg dark:border-gray-700 dark:bg-gray-950">
            {targets.length === 0 ? (
              <p className="px-3 py-1.5 text-xs text-gray-400">No other place it can go.</p>
            ) : (
              targets.map((target) => (
                <button
                  key={`${target.location.containerId ?? 'top'}-${target.label}`}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    handlers.onMoveTo(node.id, target.location);
                  }}
                  className="whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  {target.label}
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={`Delete ${nodeNoun(node)}`}
        onClick={() => handlers.onDelete(node.id)}
        className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-red-600 dark:border-gray-800"
      >
        ✕
      </button>
    </div>
  );
}

/** Chevron + drill-in controls shared by every container. */
function ContainerControls({
  id,
  name,
  noun,
  expanded,
  defaultExpanded,
  childCount,
  handlers,
}: {
  id: string;
  name: string;
  noun: string;
  expanded: boolean;
  defaultExpanded: boolean;
  childCount: number;
  handlers: CanvasHandlers;
}) {
  const label = name.trim() || `unnamed ${noun}`;
  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
      <button
        type="button"
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${noun}: ${label}`}
        onClick={() => handlers.onToggleExpand(id, defaultExpanded)}
        className="flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 hover:text-gray-800 dark:border-gray-800 dark:hover:text-gray-200"
      >
        <Icon
          path={ICONS.chevron}
          className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        {expanded ? 'Collapse' : `Expand (${childCount} inside)`}
      </button>
      <button
        type="button"
        aria-label={`Open ${noun}: ${label}`}
        onClick={() => handlers.onOpen(id)}
        className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-gray-800 dark:border-gray-800 dark:hover:text-gray-200"
      >
        Open ↗
      </button>
    </div>
  );
}

function routePill(index: number, count: number, name: string): string {
  if (index === count - 1 && count > 1) return `Otherwise: ${name}`;
  return count === 2 ? `If yes: ${name}` : `Route ${index + 1}: ${name}`;
}

/**
 * A branch body as vertical labeled route rows — THE branch rendering, at
 * every path count and depth: one column everywhere means the canvas reads
 * the same on a phone as on a desktop and nesting never grows it sideways.
 */
function RouterBlock({
  branch,
  nesting,
  ordinals,
  handlers,
}: {
  branch: BranchStep;
  nesting: Nesting;
  ordinals: Map<string, number>;
  handlers: CanvasHandlers;
}) {
  const inner: Nesting = {
    branchDepth: nesting.branchDepth + 1,
    containerDepth: nesting.containerDepth + 1,
    inLoop: nesting.inLoop,
    display: nesting.display + 1,
  };
  const routeRow = (path: BranchPath, label: string, failure: boolean) => (
    <div
      key={path.id}
      className={`border-t px-3 py-2 ${
        failure
          ? 'border-red-200 bg-red-50/40 dark:border-red-900 dark:bg-red-950/20'
          : 'border-indigo-100 dark:border-indigo-900'
      }`}
    >
      <span
        className={`inline-block max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs font-medium ${
          failure
            ? 'border-red-300 border-dashed bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
            : 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300'
        }`}
        aria-label={failure ? `Failure route: ${path.name}` : label}
      >
        {failure ? `If this decision fails: ${path.name}` : label}
      </span>
      {path.steps.length === 0 && failure ? (
        <p className="mt-1 text-xs italic text-gray-500">(swallow the failure and continue)</p>
      ) : null}
      <NodeColumn
        nodes={path.steps}
        locate={(index) => pathLocation(path.id, index)}
        nesting={inner}
        ordinals={ordinals}
        handlers={handlers}
      />
    </div>
  );
  return (
    <div className="mt-2 w-max min-w-72 max-w-full rounded-lg border border-indigo-200 bg-indigo-50/30 dark:border-indigo-900 dark:bg-indigo-950/20">
      {branch.paths.map((path, index) =>
        routeRow(path, routePill(index, branch.paths.length, path.name), false)
      )}
      {branch.failurePath ? routeRow(branch.failurePath, '', true) : null}
    </div>
  );
}

function LoopContainer({
  loop,
  nesting,
  ordinals,
  handlers,
  forceExpanded = false,
  children,
}: {
  loop: LoopStep;
  nesting: Nesting;
  ordinals: Map<string, number>;
  handlers: CanvasHandlers;
  forceExpanded?: boolean;
  /** The header card + selected-node controls, rendered by the caller. */
  children: ReactNode;
}) {
  // Selection expands: a just-inserted (auto-selected) or clicked container
  // must show its inside immediately, wherever it sits. An explicit Collapse
  // still wins — it writes an override.
  const selected = handlers.selection?.type === 'step' && handlers.selection.id === loop.id;
  const defaultExpanded = nesting.display < 2 || selected;
  const expanded = forceExpanded || handlers.isExpanded(loop.id, defaultExpanded);
  const inner: Nesting = {
    branchDepth: nesting.branchDepth,
    containerDepth: nesting.containerDepth + 1,
    inLoop: true,
    display: nesting.display + 1,
  };
  return (
    <div className="flex w-max flex-col items-center rounded-xl border-2 border-amber-200 bg-amber-50/20 p-2 dark:border-amber-900 dark:bg-amber-950/10">
      {children}
      {!forceExpanded ? (
        <ContainerControls
          id={loop.id}
          name={loop.name}
          noun="loop"
          expanded={expanded}
          defaultExpanded={defaultExpanded}
          childCount={loop.steps.length}
          handlers={handlers}
        />
      ) : null}
      {expanded ? (
        <>
          <NodeColumn
            nodes={loop.steps}
            locate={(index) => bodyLocation(loop.id, index)}
            nesting={inner}
            ordinals={ordinals}
            handlers={handlers}
          />
          {/* The decorative back-edge: next iteration returns to the top. */}
          <span
            aria-hidden="true"
            className="mt-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
          >
            ⤴ repeats up to {loop.maxIterations}×
          </span>
        </>
      ) : null}
    </div>
  );
}

function GroupContainer({
  group,
  nesting,
  ordinals,
  handlers,
  forceExpanded = false,
  children,
}: {
  group: GroupStep;
  nesting: Nesting;
  ordinals: Map<string, number>;
  handlers: CanvasHandlers;
  forceExpanded?: boolean;
  children: ReactNode;
}) {
  // Groups exist to fold — collapsed by default at every depth, except
  // while selected (a just-inserted group is selected, and an empty closed
  // box would hide the very list the user is about to fill).
  const selected = handlers.selection?.type === 'step' && handlers.selection.id === group.id;
  const expanded = forceExpanded || handlers.isExpanded(group.id, selected);
  const inner: Nesting = { ...nesting, display: nesting.display + 1 };
  return (
    <div className="flex w-max flex-col items-center rounded-xl border-2 border-slate-200 bg-slate-50/40 p-2 dark:border-slate-800 dark:bg-slate-900/20">
      {children}
      {!forceExpanded ? (
        <ContainerControls
          id={group.id}
          name={group.name}
          noun="group"
          expanded={expanded}
          defaultExpanded={selected}
          childCount={group.steps.length}
          handlers={handlers}
        />
      ) : null}
      {expanded ? (
        <NodeColumn
          nodes={group.steps}
          locate={(index) => bodyLocation(group.id, index)}
          nesting={inner}
          ordinals={ordinals}
          handlers={handlers}
        />
      ) : null}
    </div>
  );
}

/** One node — its card, its controls when selected, and its body if any. */
function NodeBlock({
  node,
  index,
  count,
  nesting,
  ordinals,
  handlers,
  forceExpanded = false,
}: {
  node: AgentStepNode;
  index: number;
  count: number;
  nesting: Nesting;
  ordinals: Map<string, number>;
  handlers: CanvasHandlers;
  forceExpanded?: boolean;
}) {
  const selectedId = handlers.selection?.type === 'step' ? handlers.selection.id : null;
  const ordinal = (ordinals.get(node.id) ?? 0) + 1;
  const card = (onSelect: () => void) => {
    switch (node.kind) {
      case 'branch':
        return (
          <BranchNode
            branch={node}
            ordinal={ordinal}
            selected={selectedId === node.id}
            issueCount={handlers.issuesFor(node.id)}
            onSelect={onSelect}
          />
        );
      case 'loop':
        return (
          <LoopNode
            loop={node}
            ordinal={ordinal}
            selected={selectedId === node.id}
            issueCount={handlers.issuesFor(node.id)}
            onSelect={onSelect}
          />
        );
      case 'group':
        return (
          <GroupNode
            group={node}
            ordinal={ordinal}
            selected={selectedId === node.id}
            issueCount={handlers.issuesFor(node.id)}
            onSelect={onSelect}
          />
        );
      case 'terminal':
        return (
          <TerminalNode
            terminal={node}
            ordinal={ordinal}
            selected={selectedId === node.id}
            issueCount={handlers.issuesFor(node.id)}
            onSelect={onSelect}
          />
        );
      case 'action':
      case undefined:
        return (
          <StepNode
            step={node}
            ordinal={ordinal}
            selected={selectedId === node.id}
            issueCount={handlers.issuesFor(node.id)}
            onSelect={onSelect}
          />
        );
      default: {
        const unhandled: never = node;
        throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  };
  const header = (
    <>
      {card(() => handlers.onSelect({ type: 'step', id: node.id }))}
      {selectedId === node.id && !forceExpanded ? (
        <NodeControls node={node} index={index} count={count} handlers={handlers} />
      ) : null}
    </>
  );
  switch (node.kind) {
    case 'branch': {
      // Selection expands: a just-inserted branch is auto-selected, and its
      // routes must be visible right away wherever it sits. Collapse (an
      // explicit override) still wins.
      const defaultExpanded = nesting.display < 2 || selectedId === node.id;
      const expanded = forceExpanded || handlers.isExpanded(node.id, defaultExpanded);
      return (
        <>
          {header}
          {!forceExpanded ? (
            <ContainerControls
              id={node.id}
              name={node.name}
              noun="branch"
              expanded={expanded}
              defaultExpanded={defaultExpanded}
              childCount={
                node.paths.reduce((sum, path) => sum + path.steps.length, 0) +
                (node.failurePath?.steps.length ?? 0)
              }
              handlers={handlers}
            />
          ) : null}
          {expanded ? (
            <RouterBlock branch={node} nesting={nesting} ordinals={ordinals} handlers={handlers} />
          ) : null}
        </>
      );
    }
    case 'loop':
      return (
        <LoopContainer
          loop={node}
          nesting={nesting}
          ordinals={ordinals}
          handlers={handlers}
          forceExpanded={forceExpanded}
        >
          {header}
        </LoopContainer>
      );
    case 'group':
      return (
        <GroupContainer
          group={node}
          nesting={nesting}
          ordinals={ordinals}
          handlers={handlers}
          forceExpanded={forceExpanded}
        >
          {header}
        </GroupContainer>
      );
    case 'terminal':
    case 'action':
    case undefined:
      return header;
    default: {
      const unhandled: never = node;
      throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * One sibling list as a vertical column: leading connector, then each node
 * with a trailing connector.
 */
function NodeColumn({
  nodes,
  locate,
  nesting,
  ordinals,
  handlers,
}: {
  nodes: AgentStepNode[];
  locate: (index: number) => InsertLocation;
  nesting: Nesting;
  ordinals: Map<string, number>;
  handlers: CanvasHandlers;
}) {
  return (
    <div className="flex flex-1 flex-col items-center">
      <Connector location={locate(0)} nesting={nesting} onInsert={handlers.onInsert} />
      {nodes.map((node, index) => (
        <Fragment key={node.id}>
          <NodeBlock
            node={node}
            index={index}
            count={nodes.length}
            nesting={nesting}
            ordinals={ordinals}
            handlers={handlers}
          />
          <Connector location={locate(index + 1)} nesting={nesting} onInsert={handlers.onInsert} />
        </Fragment>
      ))}
    </div>
  );
}

export function FlowCanvas({
  nodes,
  ordinals,
  triggers,
  otherAgents,
  selection,
  issuesFor,
  triggerIssues,
  stepsIssues,
  onSelect,
  onInsert,
  onMove,
  onDelete,
  moveTargetsFor,
  onMoveTo,
}: {
  nodes: AgentStepNode[];
  /** Pre-order ordinal per node id — the numbering runs also use. */
  ordinals: Map<string, number>;
  triggers: BuilderTrigger[];
  otherAgents: AgentChoice[];
  triggerIssues: string[];
  /** Issues at the bare `steps` path (e.g. "add at least one step"). */
  stepsIssues: string[];
} & Omit<CanvasHandlers, 'isExpanded' | 'onToggleExpand' | 'onOpen'>) {
  // Expansion overrides: absent = the container's situational default
  // (top-level open, nested and groups closed). Kept per node id so a
  // toggle survives re-renders but the DOCUMENT stays untouched.
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  // Drill-in: when set, the canvas shows ONLY this container's subtree with
  // a breadcrumb back out. Pure view state — nothing about it persists.
  const [focusId, setFocusId] = useState<string | null>(null);

  const focused = useMemo(() => (focusId ? findNodeById(nodes, focusId) : null), [nodes, focusId]);
  // The focused node can be deleted (or replaced by a redraft) out from
  // under the view; fall back to the whole flow rather than a blank canvas.
  useEffect(() => {
    if (focusId && !focused) setFocusId(null);
  }, [focusId, focused]);

  const handlers: CanvasHandlers = {
    selection,
    issuesFor,
    onSelect,
    onInsert,
    onMove,
    onDelete,
    moveTargetsFor,
    onMoveTo,
    isExpanded: (id, defaultExpanded) => expandedOverrides[id] ?? defaultExpanded,
    onToggleExpand: (id, defaultExpanded) =>
      setExpandedOverrides((current) => ({
        ...current,
        [id]: !(current[id] ?? defaultExpanded),
      })),
    onOpen: (id) => setFocusId(id),
  };

  if (focused) {
    const chain = focused.ancestors.flatMap((ancestor) => {
      switch (ancestor.kind) {
        case 'branch':
          return [{ id: ancestor.branch.id, name: ancestor.branch.name.trim() || 'Branch' }];
        case 'loop':
          return [{ id: ancestor.loop.id, name: ancestor.loop.name.trim() || 'Loop' }];
        case 'group':
          return [{ id: ancestor.group.id, name: ancestor.group.name.trim() || 'Group' }];
        default: {
          const unhandled: never = ancestor;
          throw new Error(`unknown ancestor kind: ${JSON.stringify(unhandled)}`);
        }
      }
    });
    const nesting = nestingOfAncestors(focused.ancestors);
    return (
      <div className="overflow-x-auto pb-2">
        <nav
          aria-label="Flow breadcrumb"
          className="mb-3 flex flex-wrap items-center gap-1 text-sm"
        >
          <button
            type="button"
            onClick={() => setFocusId(null)}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Whole flow
          </button>
          {chain.map((crumb) => (
            <Fragment key={crumb.id}>
              <span aria-hidden="true" className="text-gray-400">
                /
              </span>
              <button
                type="button"
                onClick={() => setFocusId(crumb.id)}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {crumb.name}
              </button>
            </Fragment>
          ))}
          <span aria-hidden="true" className="text-gray-400">
            /
          </span>
          <span className="font-medium">
            {focused.node.name.trim() || `Unnamed ${nodeNoun(focused.node)}`}
          </span>
        </nav>
        <div className="mx-auto flex w-fit min-w-fit flex-col items-center">
          <NodeBlock
            node={focused.node}
            index={focused.index}
            count={focused.siblings.length}
            nesting={nesting}
            ordinals={ordinals}
            handlers={handlers}
            forceExpanded
          />
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="mx-auto flex w-fit min-w-fit flex-col items-center">
        <TriggerNode
          triggers={triggers}
          otherAgents={otherAgents}
          selectedIndex={selection?.type === 'trigger' ? selection.index : null}
          issues={triggerIssues}
          onSelect={(index) => onSelect({ type: 'trigger', index })}
          onAdd={() => onSelect({ type: 'new-trigger' })}
        />

        <NodeColumn
          nodes={nodes}
          locate={topLocation}
          nesting={TOP_NESTING}
          ordinals={ordinals}
          handlers={handlers}
        />

        <span className="rounded-full bg-gray-200 px-3 py-1 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
          Finish
        </span>

        {stepsIssues.length > 0 ? (
          <ul className="mt-3 space-y-1">
            {stepsIssues.map((issue) => (
              <li key={issue} className="text-xs text-red-600 dark:text-red-400">
                {issue}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
