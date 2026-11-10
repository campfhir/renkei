'use client';

/**
 * The operator's queue table: every live run in the organization. A press
 * on a row (or a card, on a phone) opens the run. Select turns that into
 * picking: the boxes show, a press anywhere on a row picks it, Select all
 * picks every run of the tab across its pages, and "Halt N selected" /
 * "Halt all N" halts them. What is picked and what a halt answered is
 * org-queue.model.ts's; this makes the calls and draws. Confirms first, as
 * the single-run Force halt does: a halt ends a run even while a worker
 * still looks to be on it.
 */

import React, { useReducer } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DataFrame, DataTable, Th } from '@/components/data-table';
import LocalTime from '@/components/local-time';
import { StatusPill } from '../../../agents/run-timeline';
import { sendJsonFull } from '@/lib/fetch-json';
import { useRefresh } from '@/lib/use-refresh';
import {
  haltRequest,
  haltSelectedLabel,
  initOrgQueue,
  isPicked,
  orgQueueReducer,
  selectAllLabel,
  selectAllState,
  type OrgQueueRow,
} from './org-queue.model';

interface HaltAnswer {
  halted: string[];
  refused: { runId: string; error: string }[];
}

interface HaltAllAnswer extends HaltAnswer {
  remaining: number;
}

/** A batch can't take more than this many tries to empty a queue of `total`. */
const MAX_BATCHES = 1_000;

export default function OrgQueueTable({
  rows,
  total,
  status,
  empty,
  footer,
}: {
  rows: OrgQueueRow[];
  /** How many runs the tab matches, across every page. */
  total: number;
  /** The tab's status, or undefined for every live run. */
  status: string | undefined;
  empty: string | null;
  footer: React.ReactNode;
}): React.ReactNode {
  const [state, dispatch] = useReducer(orgQueueReducer, undefined, initOrgQueue);
  const { refresh, pending } = useRefresh();
  const ids = rows.map((row) => row.id);
  const all = selectAllState(state, ids);
  const bulkLabel = haltSelectedLabel(state, rows, total);
  const allLabel = selectAllLabel(state, total);
  const scope = status ? `${status} run` : 'unfinished run';
  const router = useRouter();

  const halt = async (runs: { agentId: string; runId: string }[]) => {
    if (runs.length === 0) return;
    const what = runs.length === 1 ? 'this run' : `these ${runs.length} runs`;
    if (
      !window.confirm(
        `Halt ${what}? It stops at once and its queue jobs are cleared, even if a worker still appears to be on it.`
      )
    ) {
      return;
    }
    const runIds = runs.map((run) => run.runId);
    dispatch({ type: 'haltStarted', runIds });
    const result = await sendJsonFull<HaltAnswer>('/api/admin/agents/runs/halt', 'POST', { runs });
    if (result.error || !result.data) {
      dispatch({
        type: 'haltFailed',
        runIds,
        error: result.error ?? 'The halt did not go through.',
      });
      return;
    }
    dispatch({ type: 'haltAnswered', halted: result.data.halted, refused: result.data.refused });
    refresh();
  };

  // Every run the tab matches, in batches on the server, until none are left.
  const haltAll = async () => {
    if (
      !window.confirm(
        `Halt all ${total.toLocaleString('en-US')} ${scope}s in the organization? Each stops at once and its queue jobs are cleared. This cannot be undone.`
      )
    ) {
      return;
    }
    dispatch({ type: 'allHaltStarted', total });
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const result = await sendJsonFull<HaltAllAnswer>('/api/admin/agents/runs/halt', 'POST', {
        all: status ? { status } : {},
      });
      if (result.error || !result.data) {
        dispatch({ type: 'allHaltFailed', error: result.error ?? 'The halt did not go through.' });
        refresh();
        return;
      }
      const halted = result.data.halted.length;
      dispatch({ type: 'allHaltBatch', halted, remaining: result.data.remaining });
      if (result.data.remaining === 0 || halted === 0) break;
    }
    refresh();
  };

  const rowHalted = (row: OrgQueueRow) => state.halted.includes(row.id);
  const toggle = (row: OrgQueueRow) => dispatch({ type: 'toggle', runId: row.id, pageIds: ids });
  const runLink = (row: OrgQueueRow) => `/admin/agents/${row.agentId}/runs/${row.id}`;
  const busy = state.progress !== null || state.halting.length > 0 || pending;

  const statusCell = (row: OrgQueueRow) => (
    <>
      {rowHalted(row) ? (
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Halted</span>
      ) : (
        <StatusPill status={row.status} />
      )}
      {row.stuck ? (
        <span className="ml-1 text-xs font-medium text-red-600 dark:text-red-400">stuck</span>
      ) : null}
      {row.cancelAsked ? (
        <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400">
          cancel asked
        </span>
      ) : null}
    </>
  );

  const box = (row: OrgQueueRow, className = '') => (
    <input
      type="checkbox"
      className={className}
      aria-label={`Select run ${row.id.slice(0, 8)} of ${row.agentName}`}
      checked={isPicked(state, row.id)}
      disabled={rowHalted(row)}
      onChange={() => toggle(row)}
      // The row's own press picks it; the box's press must not pick it twice.
      onClick={(event) => event.stopPropagation()}
    />
  );

  const cardBody = (row: OrgQueueRow) => (
    <span className="min-w-0 flex-1">
      <span className="flex items-center justify-between gap-2">
        <span
          className={`truncate text-sm font-medium ${
            state.selecting ? '' : 'text-blue-700 dark:text-blue-400'
          }`}
        >
          {row.agentName}
        </span>
        <span className="shrink-0">{statusCell(row)}</span>
      </span>
      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
        {row.owner} · {row.age} · via {row.triggerKind}
      </span>
    </span>
  );

  return (
    <>
      <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2 text-sm">
        {state.selecting ? (
          <>
            {allLabel ? (
              <button
                type="button"
                onClick={() =>
                  dispatch({ type: state.allMatching ? 'clearAllMatching' : 'pickAllMatching' })
                }
                disabled={busy || (total === 0 && !state.allMatching)}
                className="rounded-md border border-gray-300 px-3 py-1 font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                {allLabel}
              </button>
            ) : null}
            {bulkLabel ? (
              <button
                type="button"
                onClick={() =>
                  void (state.allMatching ? haltAll() : halt(haltRequest(state, rows).runs))
                }
                disabled={bulkLabel.startsWith('Halting…') || pending}
                className="rounded-md bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {bulkLabel}
              </button>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">Tap runs to select them.</span>
            )}
            <button
              type="button"
              onClick={() => dispatch({ type: 'stopSelecting' })}
              disabled={state.progress !== null}
              className="ml-auto rounded-md px-3 py-1 font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            >
              Done
            </button>
          </>
        ) : (
          <>
            <span className="hidden text-gray-500 sm:inline dark:text-gray-400">
              Tap a run to open it, or Select runs to halt them.
            </span>
            <button
              type="button"
              onClick={() => dispatch({ type: 'startSelecting' })}
              disabled={rows.length === 0}
              className="ml-auto rounded-md border border-gray-300 px-3 py-1 font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Select
            </button>
          </>
        )}
      </div>
      {state.done || state.error ? (
        <div className="mb-2 text-sm">
          {state.done ? (
            <span role="status" className="text-green-700 dark:text-green-400">
              {state.done}
            </span>
          ) : null}
          {state.error ? (
            <span role="alert" className="text-red-600 dark:text-red-400">
              {state.error}
            </span>
          ) : null}
        </div>
      ) : null}
      <DataFrame
        label="Live runs"
        breakpoint="md"
        empty={
          empty ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {empty}
            </p>
          ) : undefined
        }
        table={
          <DataTable
            head={
              <>
                {state.selecting ? (
                  <Th className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select every run on this page"
                      checked={all === 'all'}
                      ref={(input) => {
                        if (input) input.indeterminate = all === 'some';
                      }}
                      onChange={() => dispatch({ type: 'toggleAll', runIds: ids })}
                    />
                  </Th>
                ) : null}
                <Th>Agent</Th>
                <Th>Owner</Th>
                <Th className="w-32">Status</Th>
                <Th className="w-36">Time in queue</Th>
                <Th className="w-40">Created</Th>
              </>
            }
          >
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={() =>
                  state.selecting ? rowHalted(row) || toggle(row) : router.push(runLink(row))
                }
                aria-selected={state.selecting ? isPicked(state, row.id) : undefined}
                className={`cursor-pointer border-t border-gray-100 align-top hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900 ${
                  isPicked(state, row.id) && state.selecting ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                } ${rowHalted(row) ? 'opacity-50' : ''}`}
              >
                {state.selecting ? <td className="px-3 py-2">{box(row)}</td> : null}
                <td className="truncate px-3 py-2">
                  {state.selecting ? (
                    <span className="font-medium">{row.agentName}</span>
                  ) : (
                    // The keyboard's way in; a press anywhere on the row does the same.
                    <Link
                      href={runLink(row)}
                      onClick={(event) => event.stopPropagation()}
                      className="text-blue-700 hover:underline dark:text-blue-400"
                    >
                      {row.agentName}
                    </Link>
                  )}
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    via {row.triggerKind}
                  </span>
                </td>
                <td className="truncate px-3 py-2 text-gray-600 dark:text-gray-400">{row.owner}</td>
                <td className="px-3 py-2">{statusCell(row)}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{row.age}</td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-600 dark:text-gray-400">
                  <LocalTime at={row.createdAt} />
                </td>
              </tr>
            ))}
          </DataTable>
        }
        cards={rows.map((row) => (
          <li key={row.id}>
            {state.selecting ? (
              // The whole card is the box's label: a press anywhere picks it.
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${
                  isPicked(state, row.id)
                    ? 'border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40'
                    : 'border-gray-200 dark:border-gray-800'
                } ${rowHalted(row) ? 'opacity-50' : ''}`}
              >
                {box(row, 'mt-1')}
                {cardBody(row)}
              </label>
            ) : (
              <Link
                href={runLink(row)}
                className={`flex items-start rounded-lg border border-gray-200 px-3 py-2 hover:border-blue-400 dark:border-gray-800 ${
                  rowHalted(row) ? 'opacity-50' : ''
                }`}
              >
                {cardBody(row)}
              </Link>
            )}
          </li>
        ))}
        footer={footer}
      />
    </>
  );
}
