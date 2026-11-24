'use client';

/**
 * The person's Fabric workspaces and what is in them. Every rule — which
 * items show, which can have a definition fetched, what the fetch sends —
 * is fabric-browser.model.ts's; this makes the calls and draws.
 */

import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { isRecord } from '@renkei/guards';
import {
  canFetchDefinition,
  definitionKindOf,
  fabricBrowserReducer,
  filterCounts,
  initialFabricBrowser,
  selectedWorkspace,
  startRequestBody,
  visibleItems,
  type ItemFilter,
  type ItemRow,
  type TableRow,
  type WorkspaceRow,
} from './fabric-browser.model';

const FILTERS: { key: ItemFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'Notebook', label: 'Notebooks' },
  { key: 'DataPipeline', label: 'Pipelines' },
  { key: 'Lakehouse', label: 'Lakehouses' },
];

const TYPE_LABEL: Record<string, string> = {
  Notebook: 'Notebook',
  DataPipeline: 'Data pipeline',
  Lakehouse: 'Lakehouse',
};

async function getJson(
  url: string
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const body: unknown = await response.json().catch(() => null);
    const record = isRecord(body) ? body : {};
    if (!response.ok) {
      return {
        ok: false,
        error: typeof record.error === 'string' ? record.error : `Failed (${response.status})`,
      };
    }
    return { ok: true, body: record };
  } catch {
    return { ok: false, error: 'Could not reach Renkei.' };
  }
}

/** A list field the routes answer, trusted to their own shape. */
function listOf<T>(body: Record<string, unknown>, key: string): T[] {
  const value = body[key];
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return Array.isArray(value) ? (value as T[]) : [];
}

const buttonClass =
  'rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';

export default function FabricBrowser() {
  const [state, dispatch] = useReducer(fabricBrowserReducer, initialFabricBrowser);
  const router = useRouter();
  const workspace = selectedWorkspace(state);

  useEffect(() => {
    void getJson('/api/fabric/workspaces').then((answer) =>
      dispatch(
        answer.ok
          ? {
              type: 'workspacesLoaded',
              workspaces: listOf<WorkspaceRow>(answer.body, 'workspaces'),
            }
          : { type: 'workspacesFailed', error: answer.error }
      )
    );
  }, []);

  function choose(workspaceId: string) {
    dispatch({ type: 'workspaceChosen', workspaceId });
    void getJson(`/api/fabric/workspaces/${workspaceId}/items`).then((answer) =>
      dispatch(
        answer.ok
          ? { type: 'itemsLoaded', workspaceId, items: listOf<ItemRow>(answer.body, 'items') }
          : { type: 'itemsFailed', workspaceId, error: answer.error }
      )
    );
  }

  function openTables(lakehouseId: string) {
    if (!workspace) return;
    dispatch({ type: 'tablesRequested', lakehouseId });
    void getJson(`/api/fabric/workspaces/${workspace.id}/lakehouses/${lakehouseId}/tables`).then(
      (answer) =>
        dispatch(
          answer.ok
            ? { type: 'tablesLoaded', lakehouseId, tables: listOf<TableRow>(answer.body, 'tables') }
            : { type: 'tablesFailed', lakehouseId, error: answer.error }
        )
    );
  }

  async function fetchDefinition(item: ItemRow) {
    const body = startRequestBody(state, item);
    if (!body) return;
    dispatch({ type: 'definitionRequested', itemId: item.id });
    try {
      const response = await fetch('/api/fabric/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const answer: unknown = await response.json().catch(() => null);
      const record = isRecord(answer) ? answer : {};
      const operation = isRecord(record.operation) ? record.operation : null;
      if (!response.ok || !operation || typeof operation.id !== 'string') {
        dispatch({
          type: 'definitionFailed',
          itemId: item.id,
          error: typeof record.error === 'string' ? record.error : `Failed (${response.status})`,
        });
        return;
      }
      dispatch({ type: 'definitionStarted', itemId: item.id });
      router.push(`/fabric/operations/${operation.id}`);
    } catch {
      dispatch({ type: 'definitionFailed', itemId: item.id, error: 'Could not reach Renkei.' });
    }
  }

  const counts = filterCounts(state);

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <nav aria-label="Workspaces" className="min-w-0">
        <h2 className="mb-2 text-sm font-semibold">Workspaces</h2>
        {state.workspaces.status === 'loading' && (
          <p className="text-sm text-gray-500">Loading workspaces…</p>
        )}
        {state.workspaces.status === 'failed' && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {state.workspaces.error}
          </p>
        )}
        {state.workspaces.status === 'ready' &&
          (state.workspaces.list.length === 0 ? (
            <p className="text-sm text-gray-500">You have no Fabric workspaces.</p>
          ) : (
            <ul className="space-y-1">
              {state.workspaces.list.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => choose(w.id)}
                    aria-current={w.id === state.workspaceId ? 'true' : undefined}
                    className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm ${
                      w.id === state.workspaceId
                        ? 'bg-blue-50 font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-900'
                    }`}
                  >
                    {w.type === 'Personal' ? 'My workspace' : w.displayName}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </nav>

      <section
        aria-label={workspace ? `Items in ${workspace.displayName}` : 'Items'}
        className="min-w-0"
      >
        {!workspace && state.workspaces.status === 'ready' && state.workspaces.list.length > 0 && (
          <p className="text-sm text-gray-500">
            Choose a workspace to see its notebooks, pipelines and lakehouses.
          </p>
        )}
        {workspace && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="mr-2 min-w-0 truncate text-sm font-semibold">
                {workspace.displayName}
              </h2>
              <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
                {FILTERS.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    aria-pressed={state.filter === filter.key}
                    onClick={() => dispatch({ type: 'filterChosen', filter: filter.key })}
                    className={`rounded-full px-2.5 py-0.5 text-xs ${
                      state.filter === filter.key
                        ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300'
                    }`}
                  >
                    {filter.label} {counts[filter.key]}
                  </button>
                ))}
              </div>
            </div>
            {state.items.status === 'loading' && (
              <p className="text-sm text-gray-500">Loading items…</p>
            )}
            {state.items.status === 'failed' && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {state.items.error}
              </p>
            )}
            {state.items.status === 'ready' && visibleItems(state).length === 0 && (
              <p className="text-sm text-gray-500">
                Nothing here{state.filter === 'all' ? '' : ' of that kind'}.
              </p>
            )}
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
              {visibleItems(state).map((item) => (
                <li key={item.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.displayName}</p>
                      <p className="truncate text-xs text-gray-500">
                        {TYPE_LABEL[item.type] ?? item.type}
                        {item.description ? ` · ${item.description}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {definitionKindOf(item) && (
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={!canFetchDefinition(state, item)}
                          onClick={() => void fetchDefinition(item)}
                        >
                          {state.starting === item.id ? 'Asking Fabric…' : 'Get definition'}
                        </button>
                      )}
                      {item.type === 'Lakehouse' && (
                        <button
                          type="button"
                          className={buttonClass}
                          aria-expanded={state.tables?.lakehouseId === item.id}
                          onClick={() =>
                            state.tables?.lakehouseId === item.id
                              ? dispatch({ type: 'tablesClosed' })
                              : openTables(item.id)
                          }
                        >
                          {state.tables?.lakehouseId === item.id ? 'Hide tables' : 'Tables'}
                        </button>
                      )}
                    </div>
                  </div>
                  {state.startError?.itemId === item.id && (
                    <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
                      {state.startError.error}
                    </p>
                  )}
                  {state.tables?.lakehouseId === item.id && (
                    <div className="mt-2">
                      {state.tables.load.status === 'loading' && (
                        <p className="text-xs text-gray-500">Loading tables…</p>
                      )}
                      {state.tables.load.status === 'failed' && (
                        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
                          {state.tables.load.error}
                        </p>
                      )}
                      {state.tables.load.status === 'ready' &&
                        (state.tables.load.list.length === 0 ? (
                          <p className="text-xs text-gray-500">No tables.</p>
                        ) : (
                          <ul
                            aria-label={`Tables in ${item.displayName}`}
                            className="space-y-0.5 text-xs"
                          >
                            {state.tables.load.list.map((table) => (
                              <li key={table.name} className="flex flex-wrap gap-x-2">
                                <span className="font-mono">{table.name}</span>
                                <span className="text-gray-500">
                                  {table.type} · {table.format}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
