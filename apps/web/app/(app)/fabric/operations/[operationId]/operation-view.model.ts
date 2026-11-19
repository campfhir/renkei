/**
 * The operation page's state (operation-view.tsx): one Fabric definition
 * fetch as the server last described it, how the page is hearing about it
 * (a live event stream, or polling when the stream will not stay open),
 * and which part of the definition is open.
 *
 * The component holds the EventSource or the poll timer and dispatches
 * what arrives; what the page makes of it — that a finished operation is
 * never overwritten by a late "running", when to stop listening, when to
 * fall back to polling, what the headline and progress say, how a
 * notebook's cells or a pipeline's activities read — is here, and tested
 * in operation-view.model.test.ts.
 */

import {
  notebookCells,
  pipelineActivities,
  type NotebookCell,
  type PipelineActivity,
} from '@renkei/connector-fabric/readable';
import type { FabricOperationView } from '@/lib/fabric/operation-view';

export type Transport = 'stream' | 'polling' | 'closed';

export interface OperationState {
  operation: FabricOperationView;
  transport: Transport;
  /** Stream errors in a row; past STREAM_FAILURES_BEFORE_POLLING the page polls instead. */
  streamFailures: number;
  /** The definition part open in the viewer; null means the main one. */
  selectedPath: string | null;
}

export type OperationAction =
  | { type: 'update'; operation: FabricOperationView }
  | { type: 'streamOpened' }
  | { type: 'streamFailed' }
  | { type: 'partChosen'; path: string };

export const STREAM_FAILURES_BEFORE_POLLING = 2;
/** How often the page polls when it has fallen back to polling. */
export const POLL_MS = 3_000;

export function initialOperation(operation: FabricOperationView): OperationState {
  return {
    operation,
    transport: operation.status === 'running' ? 'stream' : 'closed',
    streamFailures: 0,
    selectedPath: null,
  };
}

export function operationReducer(state: OperationState, action: OperationAction): OperationState {
  switch (action.type) {
    case 'update': {
      if (action.operation.id !== state.operation.id) return state;
      // An end is final: a "running" that arrives after it (a poll that
      // crossed the last stream event) changes nothing.
      if (state.operation.status !== 'running') return state;
      const settled = action.operation.status !== 'running';
      return {
        ...state,
        operation: action.operation,
        transport: settled ? 'closed' : state.transport,
        streamFailures: state.transport === 'stream' ? 0 : state.streamFailures,
      };
    }
    case 'streamOpened':
      return state.transport === 'stream' ? { ...state, streamFailures: 0 } : state;
    case 'streamFailed': {
      if (state.transport !== 'stream') return state;
      const failures = state.streamFailures + 1;
      return {
        ...state,
        streamFailures: failures,
        transport: failures >= STREAM_FAILURES_BEFORE_POLLING ? 'polling' : 'stream',
      };
    }
    case 'partChosen':
      return state.operation.parts.some((part) => part.path === action.path)
        ? { ...state, selectedPath: action.path }
        : state;
  }
}

const NOUN = { 'notebook-definition': 'notebook', 'pipeline-definition': 'data pipeline' } as const;

/** The page's headline under the item's name. */
export function headline(state: OperationState): string {
  const { operation } = state;
  const noun = NOUN[operation.kind];
  if (operation.status === 'succeeded') return `The ${noun}'s definition is ready.`;
  if (operation.status === 'failed') return `Fabric could not give the ${noun}'s definition.`;
  return `Fabric is preparing the ${noun}'s definition…`;
}

/** The progress line while it runs, or null once it has ended. */
export function progressLine(state: OperationState): string | null {
  const { operation } = state;
  if (operation.status !== 'running') return null;
  const percent = operation.percentComplete !== null ? `${operation.percentComplete}% · ` : '';
  const how =
    state.transport === 'polling'
      ? 'checking every few seconds'
      : 'this page updates the moment it is ready';
  return `${percent}${how}. You can leave — you will be notified when it is ready.`;
}

/** The parts as tabs: the content first, then the rest by path. */
export function partTabs(state: OperationState): string[] {
  const paths = state.operation.parts.map((part) => part.path);
  const main = paths.find((path) => /^(notebook|pipeline)-content\./.test(path));
  return [...(main ? [main] : []), ...paths.filter((path) => path !== main).sort()];
}

/** The part open in the viewer. */
export function selectedPart(state: OperationState): { path: string; text: string | null } | null {
  const path = state.selectedPath ?? partTabs(state)[0];
  return state.operation.parts.find((part) => part.path === path) ?? null;
}

export type PartReading =
  | { kind: 'notebook'; cells: NotebookCell[] }
  | { kind: 'pipeline'; activities: PipelineActivity[]; json: string }
  | { kind: 'text'; text: string }
  | { kind: 'binary' };

/** How the open part reads: a notebook's cells, a pipeline's activities, or its text. */
export function readPart(part: { path: string; text: string | null }): PartReading {
  if (part.text === null) return { kind: 'binary' };
  if (part.path.endsWith('.ipynb')) {
    const cells = notebookCells(part.text);
    if (cells) return { kind: 'notebook', cells };
  }
  if (part.path === 'pipeline-content.json') {
    const activities = pipelineActivities(part.text);
    if (activities) return { kind: 'pipeline', activities, json: part.text };
  }
  return { kind: 'text', text: part.text };
}

/** The file name a downloaded part is saved under: the item's name, the part's extension. */
export function downloadName(state: OperationState, path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
  const base = state.operation.itemName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'definition';
  return path === '.platform' ? `${base}.platform` : `${base}${extension}`;
}
