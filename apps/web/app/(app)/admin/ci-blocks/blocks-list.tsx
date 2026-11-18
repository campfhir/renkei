'use client';

/**
 * The Building blocks list: the organization's catalogue of pipeline
 * steps, narrowed by kind or words, each opening its editor. What it
 * shows and filters is blocks-list.model.ts.
 */

import Link from 'next/link';
import { useEffect, useReducer } from 'react';
import { getJson } from '@/lib/fetch-json';
import {
  KIND_FILTERS,
  blocksListReducer,
  emptyLine,
  initialBlocksList,
  visibleRows,
  type BlockSummaryView,
} from './blocks-list.model';

const KIND_TONES: Record<string, string> = {
  Build: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  Test: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  Package: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  Deploy: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  Checks: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export default function BlocksList() {
  const [state, dispatch] = useReducer(blocksListReducer, initialBlocksList);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<{ blocks: BlockSummaryView[] }>('/api/admin/ci-blocks');
      if (cancelled) return;
      if (result.data) dispatch({ type: 'loaded', blocks: result.data.blocks });
      else dispatch({ type: 'loadFailed', error: result.error ?? 'The blocks could not be read.' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = visibleRows(state);
  const empty = emptyLine(state);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="w-full sm:w-60">
          <span className="sr-only">Filter blocks</span>
          <input
            type="search"
            value={state.query}
            onChange={(event) => dispatch({ type: 'query', query: event.target.value })}
            placeholder="Filter blocks"
            className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
        <div role="group" aria-label="Kind" className="flex flex-wrap gap-1.5">
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.kind}
              type="button"
              aria-pressed={state.kind === filter.kind}
              onClick={() => dispatch({ type: 'kind', kind: filter.kind })}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                state.kind === filter.kind
                  ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-300'
                  : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : state.blocks === null ? (
        <p className="text-sm text-gray-500">Loading the blocks…</p>
      ) : empty ? (
        <p className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
          {empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full min-w-[720px] border-collapse text-sm" data-testid="ci-blocks">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-600 dark:bg-gray-900 dark:text-gray-400">
                <th className="w-[36%] border-b border-gray-200 px-3 py-2 dark:border-gray-800">
                  Block
                </th>
                <th className="border-b border-gray-200 px-3 py-2 dark:border-gray-800">Kind</th>
                <th className="border-b border-gray-200 px-3 py-2 dark:border-gray-800">Runs on</th>
                <th className="border-b border-gray-200 px-3 py-2 dark:border-gray-800">Needs</th>
                <th className="border-b border-gray-200 px-3 py-2 dark:border-gray-800">Version</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-gray-100 align-top last:border-0 dark:border-gray-900"
                >
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/admin/ci-blocks/${row.id}`}
                      className="font-medium text-gray-900 hover:underline dark:text-gray-100"
                    >
                      {row.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-gray-500">{row.about}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_TONES[row.kind] ?? KIND_TONES.Checks}`}
                    >
                      {row.kind}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300">{row.runsOn}</td>
                  <td className="px-3 py-2.5 break-words text-gray-700 dark:text-gray-300">
                    {row.needs}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap">{row.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-500">
        Changing a block publishes a new version. Pipelines keep the version they were built with
        until someone updates them from the code project.
      </p>
    </div>
  );
}
