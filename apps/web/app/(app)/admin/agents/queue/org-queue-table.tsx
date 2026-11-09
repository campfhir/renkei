'use client';

/**
 * The operator's queue table: every live run in the organization with a
 * box to pick it and a Halt per row, plus "Halt N selected" for a batch.
 * What is picked and what a halt answered is org-queue.model.ts's; this
 * makes the call and draws. Confirms first, as the single-run Force halt
 * does: a halt ends a run even while a worker still looks to be on it.
 */

import React, { useReducer } from 'react';
import Link from 'next/link';
import { DataFrame, DataTable, Th } from '@/components/data-table';
import LocalTime from '@/components/local-time';
import { StatusPill } from '../../../agents/run-timeline';
import { sendJsonFull } from '@/lib/fetch-json';
import { useRefresh } from '@/lib/use-refresh';
import {
  haltRequest,
  haltSelectedLabel,
  initOrgQueue,
  orgQueueReducer,
  pickAllOffer,
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
  const offer = pickAllOffer(state, ids, total);
  const scope = status ? `${status} run` : 'unfinished run';

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

  const rowBusy = (row: OrgQueueRow) => state.halting.includes(row.id) || pending;
  const rowHalted = (row: OrgQueueRow) => state.halted.includes(row.id);

  const haltButton = (row: OrgQueueRow) =>
    rowHalted(row) ? (
      <span className="text-xs text-gray-500 dark:text-gray-400">Halted</span>
    ) : (
      <button
        type="button"
        onClick={() => void halt([{ agentId: row.agentId, runId: row.id }])}
        disabled={rowBusy(row)}
        aria-label={`Halt run ${row.id.slice(0, 8)} of ${row.agentName}`}
        className="rounded-md border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:border-red-500 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        {state.halting.includes(row.id) ? 'Halting…' : 'Halt'}
      </button>
    );

  const runLink = (row: OrgQueueRow) => `/admin/agents/${row.agentId}/runs/${row.id}`;
  const statusCell = (row: OrgQueueRow) => (
    <>
      <StatusPill status={row.status} />
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

  return (
    <>
      <div className="mb-2 flex min-h-8 flex-wrap items-center gap-3 text-sm">
        {bulkLabel ? (
          <button
            type="button"
            onClick={() =>
              void (state.allMatching ? haltAll() : halt(haltRequest(state, rows).runs))
            }
            disabled={bulkLabel.startsWith('Halting…') || pending}
            className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {bulkLabel}
          </button>
        ) : (
          <span className="text-gray-500 dark:text-gray-400">
            Pick runs to halt them together, or halt one from its row.
          </span>
        )}
        {offer ? (
          <span className="text-gray-600 dark:text-gray-400">
            {offer.text}{' '}
            <button
              type="button"
              onClick={() =>
                dispatch({ type: offer.action === 'pick' ? 'pickAllMatching' : 'clearAllMatching' })
              }
              className="font-medium text-blue-700 hover:underline dark:text-blue-400"
            >
              {offer.action === 'pick'
                ? `Pick all ${total.toLocaleString('en-US')} ${scope}s`
                : 'Clear the selection'}
            </button>
          </span>
        ) : null}
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
                <Th className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Pick every run on this page"
                    checked={all === 'all'}
                    ref={(box) => {
                      if (box) box.indeterminate = all === 'some';
                    }}
                    onChange={() => dispatch({ type: 'toggleAll', runIds: ids })}
                  />
                </Th>
                <Th>Agent</Th>
                <Th>Owner</Th>
                <Th className="w-32">Status</Th>
                <Th className="w-36">Time in queue</Th>
                <Th className="w-40">Created</Th>
                <Th className="w-24 text-right">
                  <span className="sr-only">Halt</span>
                </Th>
              </>
            }
          >
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-t border-gray-100 align-top dark:border-gray-800 ${rowHalted(row) ? 'opacity-50' : ''}`}
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Pick run ${row.id.slice(0, 8)} of ${row.agentName}`}
                    checked={state.selected.includes(row.id)}
                    disabled={rowHalted(row)}
                    onChange={() => dispatch({ type: 'toggle', runId: row.id })}
                  />
                </td>
                <td className="truncate px-3 py-2">
                  <Link
                    href={runLink(row)}
                    className="text-blue-700 hover:underline dark:text-blue-400"
                  >
                    {row.agentName}
                  </Link>
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
                <td className="px-3 py-2 text-right">{haltButton(row)}</td>
              </tr>
            ))}
          </DataTable>
        }
        cards={rows.map((row) => (
          <li
            key={row.id}
            className={`rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-800 ${rowHalted(row) ? 'opacity-50' : ''}`}
          >
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                aria-label={`Pick run ${row.id.slice(0, 8)} of ${row.agentName}`}
                checked={state.selected.includes(row.id)}
                disabled={rowHalted(row)}
                onChange={() => dispatch({ type: 'toggle', runId: row.id })}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={runLink(row)}
                    className="truncate text-sm text-blue-700 dark:text-blue-400"
                  >
                    {row.agentName}
                  </Link>
                  <span className="shrink-0">{statusCell(row)}</span>
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {row.owner} · {row.age} · via {row.triggerKind}
                </div>
              </div>
              <div className="shrink-0">{haltButton(row)}</div>
            </div>
          </li>
        ))}
        footer={footer}
      />
    </>
  );
}
