'use client';

/**
 * The flow chart: trigger cluster at the top, nodes joined by connector
 * lines, branches fanning into two path columns and merging back, a Finish
 * pill at the bottom. Reading it IS reading the recipe; editing happens in
 * the panel that opens when a node is selected.
 *
 * Every connector carries an always-visible "+" (mobile has no hover) that
 * opens a two-item menu — add a step, add an if/else branch — inserting at
 * that exact edge. The fan/merge curves are two tiny stretched SVGs; no
 * flow library, the layout is plain grid/flex.
 */

import { useRef, useState, Fragment } from 'react';
import {
  isBranchStep,
  MAX_BRANCH_DEPTH,
  type AgentStepNode,
  type BranchStep,
} from '@renkei/agents';
import type { InsertLocation } from './flow-tree';
import type { AgentChoice, BuilderTrigger } from './trigger-node';
import { TriggerNode } from './trigger-node';
import { StepNode } from './step-node';
import { BranchNode } from './branch-node';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';

export type BuilderSelection =
  { type: 'step'; id: string } | { type: 'trigger'; index: number } | { type: 'new-trigger' };

interface CanvasHandlers {
  selection: BuilderSelection | null;
  issuesFor: (nodeId: string) => number;
  onSelect: (selection: BuilderSelection | null) => void;
  onInsert: (location: InsertLocation, kind: 'step' | 'branch') => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDelete: (id: string) => void;
}

function Connector({
  location,
  allowBranch,
  onInsert,
  grow = false,
}: {
  location: InsertLocation;
  allowBranch: boolean;
  onInsert: CanvasHandlers['onInsert'];
  /** Stretch to fill the column so both branch legs reach the merge. */
  grow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Clicking anywhere else (or Escape) cancels the add — each connector owns
  // its own popup, so without this they only closed by re-clicking their "+".
  useDismiss(open, menuRef, () => setOpen(false));
  return (
    <div
      ref={menuRef}
      className={`relative flex ${grow ? 'min-h-9 flex-1' : 'h-9'} flex-col items-center`}
    >
      <span aria-hidden="true" className="h-full w-px bg-gray-300 dark:bg-gray-700" />
      <button
        type="button"
        aria-label="Add here"
        title="Add a step or branch here"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="absolute top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-gray-300 bg-white text-xs leading-none text-gray-400 hover:border-blue-500 hover:text-blue-600 dark:border-gray-700 dark:bg-gray-950 dark:hover:border-blue-400"
      >
        +
      </button>
      {open ? (
        <div className="absolute left-1/2 top-1/2 z-20 ml-4 flex w-max -translate-y-1/2 flex-col overflow-hidden rounded-md border border-gray-200 bg-white text-left shadow-lg dark:border-gray-700 dark:bg-gray-950">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onInsert(location, 'step');
            }}
            className="flex items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.step} className="h-4 w-4 text-gray-400" />
            Add a step
          </button>
          {allowBranch ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onInsert(location, 'branch');
              }}
              className="flex items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <Icon path={ICONS.branch} className="h-4 w-4 text-indigo-500" />
              Add an if/else branch
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The two bezier legs from a branch card down into its path columns. */
function FanOut() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="h-8 w-full text-gray-300 dark:text-gray-700"
    >
      <path
        d="M50 0 C 50 16, 25 16, 25 32"
        fill="none"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
        strokeWidth="1.5"
      />
      <path
        d="M50 0 C 50 16, 75 16, 75 32"
        fill="none"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** The mirror: both legs joining back to the spine after the block. */
function Merge() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="h-8 w-full text-gray-300 dark:text-gray-700"
    >
      <path
        d="M25 0 C 25 16, 50 16, 50 32"
        fill="none"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
        strokeWidth="1.5"
      />
      <path
        d="M75 0 C 75 16, 50 16, 50 32"
        fill="none"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function NodeControls({
  id,
  index,
  count,
  isBranch,
  onMove,
  onDelete,
}: {
  id: string;
  index: number;
  count: number;
  isBranch: boolean;
  onMove: CanvasHandlers['onMove'];
  onDelete: CanvasHandlers['onDelete'];
}) {
  return (
    <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
      <button
        type="button"
        aria-label="Move up"
        disabled={index === 0}
        onClick={() => onMove(id, -1)}
        className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-gray-800 disabled:opacity-30 dark:border-gray-800 dark:hover:text-gray-200"
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Move down"
        disabled={index === count - 1}
        onClick={() => onMove(id, 1)}
        className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-gray-800 disabled:opacity-30 dark:border-gray-800 dark:hover:text-gray-200"
      >
        ↓
      </button>
      <button
        type="button"
        aria-label={isBranch ? 'Delete branch' : 'Delete step'}
        onClick={() => onDelete(id)}
        className="rounded border border-gray-200 px-1.5 py-0.5 hover:text-red-600 dark:border-gray-800"
      >
        ✕
      </button>
    </div>
  );
}

function BranchBlock({
  branch,
  depth,
  ordinals,
  handlers,
}: {
  branch: BranchStep;
  depth: number;
  ordinals: Map<string, number>;
  handlers: CanvasHandlers;
}) {
  return (
    // Content-sized, not parent-sized: the block must be free to be WIDER
    // than the single-column spine (the canvas scrolls horizontally), and
    // both path columns get the same minimum so the fan-out endpoints line
    // up with the column centers.
    <div className="flex w-max max-w-none flex-col items-center">
      <FanOut />
      <div className="grid grid-cols-2 gap-x-4">
        {branch.paths.map((path, pathIndex) => (
          <div key={path.id} className="flex min-w-64 flex-col items-center">
            <span
              className={`max-w-56 truncate rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                pathIndex === 0
                  ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300'
                  : 'border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'
              }`}
            >
              {pathIndex === 0 ? 'If yes' : 'Otherwise'}: {path.name}
            </span>
            <NodeColumn
              nodes={path.steps}
              pathId={path.id}
              depth={depth + 1}
              ordinals={ordinals}
              handlers={handlers}
              growTail
            />
          </div>
        ))}
      </div>
      <Merge />
    </div>
  );
}

/**
 * One sibling list as a vertical column: leading connector, then each node
 * with a trailing connector. `growTail` makes the LAST connector stretch,
 * so both legs of a branch visually reach the merge curve.
 */
function NodeColumn({
  nodes,
  pathId,
  depth,
  ordinals,
  handlers,
  growTail = false,
}: {
  nodes: AgentStepNode[];
  pathId: string | null;
  depth: number;
  ordinals: Map<string, number>;
  handlers: CanvasHandlers;
  growTail?: boolean;
}) {
  const allowBranch = depth < MAX_BRANCH_DEPTH;
  const selectedId = handlers.selection?.type === 'step' ? handlers.selection.id : null;
  return (
    <div className="flex flex-1 flex-col items-center">
      <Connector
        location={{ pathId, index: 0 }}
        allowBranch={allowBranch}
        onInsert={handlers.onInsert}
        grow={growTail && nodes.length === 0}
      />
      {nodes.map((node, index) => (
        <Fragment key={node.id}>
          {isBranchStep(node) ? (
            <>
              <BranchNode
                branch={node}
                selected={selectedId === node.id}
                issueCount={handlers.issuesFor(node.id)}
                onSelect={() => handlers.onSelect({ type: 'step', id: node.id })}
              />
              {selectedId === node.id ? (
                <NodeControls
                  id={node.id}
                  index={index}
                  count={nodes.length}
                  isBranch
                  onMove={handlers.onMove}
                  onDelete={handlers.onDelete}
                />
              ) : null}
              <BranchBlock branch={node} depth={depth} ordinals={ordinals} handlers={handlers} />
            </>
          ) : (
            <>
              <StepNode
                step={node}
                ordinal={(ordinals.get(node.id) ?? 0) + 1}
                selected={selectedId === node.id}
                issueCount={handlers.issuesFor(node.id)}
                onSelect={() => handlers.onSelect({ type: 'step', id: node.id })}
              />
              {selectedId === node.id ? (
                <NodeControls
                  id={node.id}
                  index={index}
                  count={nodes.length}
                  isBranch={false}
                  onMove={handlers.onMove}
                  onDelete={handlers.onDelete}
                />
              ) : null}
            </>
          )}
          <Connector
            location={{ pathId, index: index + 1 }}
            allowBranch={allowBranch}
            onInsert={handlers.onInsert}
            grow={growTail && index === nodes.length - 1}
          />
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
}: {
  nodes: AgentStepNode[];
  /** Pre-order ordinal per node id — the numbering runs also use. */
  ordinals: Map<string, number>;
  triggers: BuilderTrigger[];
  otherAgents: AgentChoice[];
  triggerIssues: string[];
  /** Issues at the bare `steps` path (e.g. "add at least one step"). */
  stepsIssues: string[];
} & CanvasHandlers) {
  const handlers: CanvasHandlers = { selection, issuesFor, onSelect, onInsert, onMove, onDelete };
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

        <NodeColumn nodes={nodes} pathId={null} depth={1} ordinals={ordinals} handlers={handlers} />

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
