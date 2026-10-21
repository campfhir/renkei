'use client';

/**
 * The admin's list of MCP servers, with one inline form for creating or
 * editing. A server's tool prefix (`slug`) is fixed once created — chats
 * remember tools by it and switches name it. Saving a different server URL,
 * sign-in mode or client ends everyone's connection; the form says so
 * before it is saved. "Check" runs discovery through the delegate and
 * reports what it found, without anyone's token.
 */

import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';

interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: 'streamable_http' | 'sse';
  authMode: 'oauth' | 'none';
  context: string;
  scopes: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  enabled: boolean;
  discovered: boolean;
  issuer: string | null;
  supportsRegistration: boolean;
}

interface Draft {
  id: string | null;
  name: string;
  slug: string;
  url: string;
  transport: 'streamable_http' | 'sse';
  authMode: 'oauth' | 'none';
  context: string;
  scopes: string;
  clientId: string;
  clientSecret: string;
  clearClientSecret: boolean;
  hasClientSecret: boolean;
  enabled: boolean;
}

interface CheckResponse {
  ok: boolean;
  open?: boolean;
  problem?: string;
  message?: string;
  server: ServerRow;
}

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const buttonClass =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';

const emptyDraft = (): Draft => ({
  id: null,
  name: '',
  slug: '',
  url: '',
  transport: 'streamable_http',
  authMode: 'oauth',
  context: '',
  scopes: '',
  clientId: '',
  clientSecret: '',
  clearClientSecret: false,
  hasClientSecret: false,
  enabled: true,
});

const draftOf = (row: ServerRow): Draft => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  url: row.url,
  transport: row.transport,
  authMode: row.authMode,
  context: row.context,
  scopes: row.scopes ?? '',
  clientId: row.clientId ?? '',
  clientSecret: '',
  clearClientSecret: false,
  hasClientSecret: row.hasClientSecret,
  enabled: row.enabled,
});

function payload(draft: Draft): Record<string, unknown> {
  return {
    name: draft.name,
    ...(draft.id ? {} : { slug: draft.slug }),
    url: draft.url,
    transport: draft.transport,
    authMode: draft.authMode,
    context: draft.context,
    scopes: draft.scopes,
    clientId: draft.clientId,
    ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
    clearClientSecret: draft.clearClientSecret,
    enabled: draft.enabled,
  };
}

export function checkText(result: CheckResponse): string {
  if (!result.ok) return result.message ?? 'The server could not be checked.';
  if (result.open) return 'Reachable — this server asked for no sign-in, so anyone can use it.';
  if (result.server.authMode === 'none') return 'Reachable — no sign-in is used for this server.';
  const registration = result.server.clientId
    ? 'Renkei has a client registered there.'
    : result.server.supportsRegistration
      ? 'Renkei will register itself on first connect.'
      : 'It offers no automatic registration: enter the client ID it issued for Renkei.';
  return `Reachable — signs in at ${result.server.issuer ?? 'its authorization server'}. ${registration}`;
}

export default function ServerManager() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ servers: ServerRow[] }>(
      '/api/admin/mcp-servers'
    );
    if (loadError) setError(loadError);
    else setServers(data?.servers ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const saveError = await sendJson(
      draft.id ? `/api/admin/mcp-servers/${draft.id}` : '/api/admin/mcp-servers',
      draft.id ? 'PATCH' : 'POST',
      payload(draft)
    );
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setDraft(null);
    await load();
  };

  const check = async (id: string) => {
    setNotes((current) => ({ ...current, [id]: 'Checking…' }));
    const { data, error: checkError } = await sendJsonFull<CheckResponse>(
      `/api/admin/mcp-servers/${id}/check`,
      'POST',
      {}
    );
    setNotes((current) => ({
      ...current,
      [id]: checkError || !data ? (checkError ?? 'The check did not answer.') : checkText(data),
    }));
    await load();
  };

  const remove = async (row: ServerRow) => {
    if (!window.confirm(`Delete ${row.name}? Everyone's connection to it ends.`)) return;
    const deleteError = await sendJson(`/api/admin/mcp-servers/${row.id}`, 'DELETE');
    if (deleteError) setError(deleteError);
    else await load();
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <div className="space-y-4">
      {servers.length === 0 && !draft ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">No MCP servers listed yet.</p>
      ) : null}

      <ul className="space-y-2" data-testid="mcp-server-list">
        {servers.map((row) => (
          <li key={row.id} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {row.name}
                  <code className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal dark:bg-gray-800">
                    {row.slug}__*
                  </code>
                  <span className="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs font-normal text-gray-600 dark:border-gray-700 dark:text-gray-400">
                    {row.transport === 'sse' ? 'SSE' : 'Streamable HTTP'}
                  </span>
                  {row.authMode === 'none' ? (
                    <span className="ml-2 rounded-full border border-amber-300 px-2 py-0.5 text-xs font-normal text-amber-700 dark:border-amber-800 dark:text-amber-400">
                      no sign-in
                    </span>
                  ) : null}
                  {!row.enabled ? (
                    <span className="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400">
                      off
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                  {row.url}
                </p>
                {row.context ? (
                  <p className="mt-1 line-clamp-2 text-xs text-gray-600 dark:text-gray-400">
                    {row.context}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-3 text-sm font-medium">
                <button
                  type="button"
                  onClick={() => void check(row.id)}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Check
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(draftOf(row))}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(row)}
                  className="text-red-600 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
            {notes[row.id] ? (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{notes[row.id]}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <p className="text-sm font-medium">
            {draft.id ? `Edit ${draft.name}` : 'New MCP server'}
          </p>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Name</span>
            <input
              className={inputClass}
              value={draft.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder="Acme Docs"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Server URL</span>
            <input
              className={`${inputClass} font-mono`}
              value={draft.url}
              onChange={(event) => set('url', event.target.value)}
              placeholder="https://mcp.example.com/mcp"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Transport</span>
              <select
                className={inputClass}
                value={draft.transport}
                onChange={(event) =>
                  set('transport', event.target.value === 'sse' ? 'sse' : 'streamable_http')
                }
              >
                <option value="streamable_http">Streamable HTTP</option>
                <option value="sse">Legacy HTTP + SSE</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Sign-in</span>
              <select
                className={inputClass}
                value={draft.authMode}
                onChange={(event) =>
                  set('authMode', event.target.value === 'none' ? 'none' : 'oauth')
                }
              >
                <option value="oauth">The server signs people in (OAuth)</option>
                <option value="none">None — an open server</option>
              </select>
            </label>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Context</span>
            <textarea
              className={inputClass}
              rows={4}
              value={draft.context}
              onChange={(event) => set('context', event.target.value)}
              placeholder="What this server is for, the systems and vocabulary it covers. Used to find it and shown to the model beside its tools."
            />
            <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
              {draft.context.length} / 4000
            </span>
          </label>

          {!draft.id ? (
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Tool prefix (optional)</span>
              <input
                className={`${inputClass} font-mono`}
                value={draft.slug}
                onChange={(event) => set('slug', event.target.value)}
                placeholder="derived from the name"
              />
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                Tools are named prefix__tool. It cannot change after the server is created.
              </span>
            </label>
          ) : null}

          {draft.authMode === 'oauth' ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Advanced sign-in settings</summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Renkei registers itself with the server automatically when the server allows it.
                  Fill these in only for a server that issued a client for Renkei by hand.
                </p>
                <label className="block">
                  <span className="mb-1 block font-medium">Client ID</span>
                  <input
                    className={`${inputClass} font-mono`}
                    value={draft.clientId}
                    onChange={(event) => set('clientId', event.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block font-medium">
                    Client secret {draft.hasClientSecret ? '(stored — type to replace)' : ''}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    className={`${inputClass} font-mono`}
                    value={draft.clientSecret}
                    onChange={(event) => set('clientSecret', event.target.value)}
                  />
                </label>
                {draft.hasClientSecret ? (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.clearClientSecret}
                      onChange={(event) => set('clearClientSecret', event.target.checked)}
                    />
                    Remove the stored secret
                  </label>
                ) : null}
                <label className="block">
                  <span className="mb-1 block font-medium">Scopes (optional)</span>
                  <input
                    className={`${inputClass} font-mono`}
                    value={draft.scopes}
                    onChange={(event) => set('scopes', event.target.value)}
                    placeholder="what the server advertises"
                  />
                </label>
              </div>
            </details>
          ) : null}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => set('enabled', event.target.checked)}
            />
            Offered to people
          </label>

          {draft.id ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Changing the server&apos;s address, its sign-in mode, or its client ends
              everyone&apos;s connection to it.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !draft.name.trim() || !draft.url.trim()}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {draft.id ? 'Save changes' : 'Add server'}
            </button>
            <button type="button" onClick={() => setDraft(null)} className={buttonClass}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDraft(emptyDraft())}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add MCP server
        </button>
      )}

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
