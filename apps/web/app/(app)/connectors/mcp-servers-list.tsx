'use client';

/**
 * The person's remote MCP servers on the Connectors page. What each card
 * shows and what an answer leaves on it is mcp-servers-list.model.ts's;
 * this makes the calls and draws.
 */

import { useEffect, useReducer } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import {
  cardButtons,
  init,
  listsOnFirstSight,
  loadsOnToggle,
  reducer,
  statusBadge,
  toolList,
  transportLabel,
  type McpServerView,
  type ToolView,
} from './mcp-servers-list.model';

export type { McpServerView } from './mcp-servers-list.model';

const buttonClass =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';

function ServerRow({ initial }: { initial: McpServerView }) {
  const [state, dispatch] = useReducer(reducer, initial, init);
  const { server, busy, error } = state;
  const toolsUrl = `/api/mcp-servers/${server.id}/tools`;

  const loadTools = async () => {
    const { data, error: loadError } = await getJson<{ tools: ToolView[] }>(toolsUrl);
    if (loadError) dispatch({ type: 'toolsLoadFailed', error: loadError });
    else dispatch({ type: 'toolsLoaded', tools: data?.tools ?? [] });
  };

  const toggle = async () => {
    const load = loadsOnToggle(state);
    dispatch({ type: 'toolsToggled' });
    if (load) await loadTools();
  };

  const refresh = async (reveal = true) => {
    dispatch({ type: 'refreshStarted' });
    const { data, error: refreshError } = await sendJsonFull<{ tools: ToolView[] }>(
      toolsUrl,
      'POST',
      {}
    );
    if (refreshError || !data) dispatch({ type: 'refreshFailed', error: refreshError });
    else dispatch({ type: 'refreshed', tools: data.tools, reveal });
  };

  // An open server has no connect step to list its tools after, so the
  // first look at the card asks it.
  useEffect(() => {
    if (listsOnFirstSight(initial)) void refresh(false);
    // Once per card, on mount only.
  }, []);

  const disconnect = async () => {
    dispatch({ type: 'disconnectStarted' });
    const disconnectError = await sendJson(`/api/mcp-servers/${server.id}/grant`, 'DELETE');
    if (disconnectError) dispatch({ type: 'disconnectFailed', error: disconnectError });
    else dispatch({ type: 'disconnected' });
  };

  const badge = statusBadge(server);
  const buttons = cardButtons(state);
  const list = state.open ? toolList(state) : null;

  return (
    <li
      className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
      data-testid={`mcp-server-${server.slug}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {server.name}
            <span className="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs font-normal text-gray-600 dark:border-gray-700 dark:text-gray-400">
              {transportLabel(server)}
            </span>
            {badge ? (
              <span className="ml-2 rounded-full border border-green-300 px-2 py-0.5 text-xs font-normal text-green-700 dark:border-green-800 dark:text-green-400">
                {badge}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
            {server.host}
          </p>
          {server.context ? (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{server.context}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {buttons.kind === 'usable' ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void toggle()}
                className={buttonClass}
              >
                {buttons.toolsLabel}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
                className={buttonClass}
              >
                {buttons.refreshLabel}
              </button>
              {buttons.disconnect ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void disconnect()}
                  className={buttonClass}
                >
                  Disconnect
                </button>
              ) : null}
            </>
          ) : (
            <a
              href={buttons.href}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Connect
            </a>
          )}
        </div>
      </div>

      {list?.kind === 'loading' ? (
        <p className="mt-2 text-sm text-gray-500">Loading…</p>
      ) : list?.kind === 'empty' ? (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          The server lists no tools for you.
        </p>
      ) : list?.kind === 'tools' ? (
        <ul className="mt-2 space-y-1">
          {list.tools.map((tool) => (
            <li key={tool.key} className="text-sm">
              <code className="text-xs">{tool.name}</code>
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{tool.access}</span>
              {tool.description ? (
                <span className="ml-2 text-gray-600 dark:text-gray-400">{tool.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </li>
  );
}

export default function McpServersList({ servers }: { servers: McpServerView[] }) {
  return (
    <ul className="mt-3 space-y-2">
      {servers.map((server) => (
        <ServerRow key={server.id} initial={server} />
      ))}
    </ul>
  );
}
