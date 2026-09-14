'use client';

/**
 * The workspace-environment card on the connectors page — the variables a
 * person's sandbox commands run with (`NPM_TOKEN`, a test database URL,
 * an API key for a service the project talks to). A value is typed here,
 * sent to the sandbox worker once, sealed there, and never shown again:
 * the model can see the names, a command gets the values in its
 * environment, and the worker masks every value out of every output.
 * Setting a name that exists replaces its value. None of this is
 * reachable through MCP.
 */

import { useState } from 'react';
import { sendJson, sendJsonFull } from '@/lib/fetch-json';
import { inputClass } from '../admin/file-shares/share-config-fields';

export interface EnvVariableView {
  id: string;
  name: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

function when(value: string): string {
  return new Date(value).toLocaleString();
}

export default function SandboxEnv({
  tenantId,
  variables: initialVariables,
}: {
  tenantId: string;
  variables: EnvVariableView[];
}) {
  const [variables, setVariables] = useState(initialVariables);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/tenant/${tenantId}/sandbox/env`;

  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ variable: EnvVariableView }>(base, 'PUT', {
      name: name.trim().toUpperCase(),
      value,
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'Could not save the variable');
      return;
    }
    const saved = result.data.variable;
    setVariables((current) =>
      [...current.filter((entry) => entry.name !== saved.name), saved].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    );
    setName('');
    setValue('');
  };

  const remove = async (variable: EnvVariableView) => {
    if (!window.confirm(`Remove ${variable.name}? Commands will no longer see it.`)) return;
    setBusy(true);
    setError(null);
    const saveError = await sendJson(`${base}/${encodeURIComponent(variable.name)}`, 'DELETE');
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setVariables((current) => current.filter((entry) => entry.name !== variable.name));
  };

  const existing = variables.some((entry) => entry.name === name.trim().toUpperCase());

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="text-base font-semibold">Workspace environment</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Variables your workspace commands run with — a package registry token, a test database URL,
        an API key a project needs. A value is sealed on the sandbox worker and never shown again,
        not to you and not to the model: commands get it in their environment, and it is masked out
        of everything they print.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="NPM_TOKEN"
            autoComplete="off"
            spellCheck={false}
            className={`mt-1 w-full font-mono ${inputClass}`}
          />
        </label>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
          Value
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="new-password"
            className={`mt-1 w-full font-mono ${inputClass}`}
          />
        </label>
        <div className="flex items-end">
          <button
            type="button"
            disabled={busy || !name.trim() || !value}
            onClick={() => void save()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {existing ? 'Replace' : 'Add'}
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {variables.length === 0 ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No variables set.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-200 rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {variables.map((variable) => (
            <li key={variable.name} className="flex items-center justify-between gap-2 px-2.5 py-2">
              <span className="min-w-0 truncate">
                <span className="font-mono text-sm font-medium">{variable.name}</span>
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  set {when(variable.updatedAt)}
                  {variable.lastUsedAt ? ` · last used ${when(variable.lastUsedAt)}` : ''}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(variable)}
                className="shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
