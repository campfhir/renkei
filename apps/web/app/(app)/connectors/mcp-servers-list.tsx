'use client';

import { useEffect, useState } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';

export interface McpServerView {
  id: string;
  slug: string;
  name: string;
  host: string;
  transport: 'streamable_http' | 'sse';
  authMode: 'oauth' | 'none';
  context: string;
  connected: boolean;
  toolCount: number;
}

interface ToolView {
  name: string;
  description: string;
  readOnly: boolean;
}

const buttonClass =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';

function ServerRow({ initial }: { initial: McpServerView }) {
  const [server, setServer] = useState(initial);
  const [tools, setTools] = useState<ToolView[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usable = server.authMode === 'none' || server.connected;

  const loadTools = async () => {
    const { data, error: loadError } = await getJson<{ tools: ToolView[] }>(
      `/api/mcp-servers/${server.id}/tools`
    );
    if (loadError) setError(loadError);
    else setTools(data?.tools ?? []);
  };

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && tools === null) await loadTools();
  };

  const refresh = async (reveal = true) => {
    setBusy(true);
    setError(null);
    const { data, error: refreshError } = await sendJsonFull<{ tools: ToolView[] }>(
      `/api/mcp-servers/${server.id}/tools`,
      'POST',
      {}
    );
    setBusy(false);
    if (refreshError || !data) {
      setError(refreshError ?? 'The server did not answer.');
      return;
    }
    setTools(data.tools);
    setServer((current) => ({
      ...current,
      toolCount: data.tools.length,
      connected: current.authMode === 'oauth' ? true : current.connected,
    }));
    if (reveal) setOpen(true);
  };

  // An open server has no connect step to list its tools after, so the
  // first look at the card asks it.
  useEffect(() => {
    if (initial.authMode === 'none' && initial.toolCount === 0) void refresh(false);
    // Once per card, on mount only.
  }, []);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    const disconnectError = await sendJson(`/api/mcp-servers/${server.id}/grant`, 'DELETE');
    setBusy(false);
    if (disconnectError) {
      setError(disconnectError);
      return;
    }
    setTools(null);
    setOpen(false);
    setServer((current) => ({ ...current, connected: false, toolCount: 0 }));
  };

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
              {server.transport === 'sse' ? 'SSE' : 'Streamable HTTP'}
            </span>
            {usable ? (
              <span className="ml-2 rounded-full border border-green-300 px-2 py-0.5 text-xs font-normal text-green-700 dark:border-green-800 dark:text-green-400">
                {server.authMode === 'none' ? 'open' : 'connected'}
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
          {usable ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void toggle()}
                className={buttonClass}
              >
                {open ? 'Hide tools' : `Tools (${server.toolCount})`}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
                className={buttonClass}
              >
                {busy ? 'Working…' : 'Refresh tools'}
              </button>
              {server.authMode === 'oauth' ? (
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
              href={`/api/mcp-servers/${server.id}/authorize`}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Connect
            </a>
          )}
        </div>
      </div>

      {open ? (
        tools === null ? (
          <p className="mt-2 text-sm text-gray-500">Loading…</p>
        ) : tools.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            The server lists no tools for you.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {tools.map((tool) => (
              <li key={tool.name} className="text-sm">
                <code className="text-xs">{`${server.slug}__${tool.name}`}</code>
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {tool.readOnly ? 'read' : 'act'}
                </span>
                {tool.description ? (
                  <span className="ml-2 text-gray-600 dark:text-gray-400">{tool.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )
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
