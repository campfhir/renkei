'use client';

/**
 * The Mirth Connect card on the connectors page — where a person connects
 * each of the org's Mirth servers (dev, test, prod…) with their OWN Mirth
 * account, the same gesture as the file-shares card. The admin registers
 * where a server lives; this card is who you are on it. Connecting
 * validates the credential against the live server before anything is
 * stored (a wrong password fails here, not later), and the checkboxes are
 * the person's LLM-exposure choice: whether the model's tools may act
 * (deploy, start/stop, send messages, edit configuration), and separately
 * whether they may run destructive operations (delete channels, purge
 * message stores…). Reading is what a connection is for, so it is always
 * on; Mirth's own roles still judge every request by the connected
 * account.
 */

import { useState } from 'react';
import { sendJson } from '@/lib/fetch-json';
import { inputClass } from '../admin/mirth/instance-config-fields';

export interface MirthConnectionView {
  username: string;
  toolAccess: 'read' | 'read_write';
  allowDestructive: boolean;
}

export interface ConnectableMirthInstanceView {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  connection: MirthConnectionView | null;
}

interface ConnectDraft {
  username: string;
  password: string;
  write: boolean;
  destructive: boolean;
}

const EMPTY_DRAFT: ConnectDraft = { username: '', password: '', write: false, destructive: false };

/** The exposure checkbox trio, shared by the connect form and the row. */
function ExposureBoxes({
  name,
  write,
  destructive,
  disabled,
  onChange,
}: {
  name: string;
  write: boolean;
  destructive: boolean;
  disabled: boolean;
  onChange: (write: boolean, destructive: boolean) => void;
}) {
  const boxClass = 'h-4 w-4 accent-blue-600';
  return (
    <span className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <input type="checkbox" className={boxClass} checked disabled aria-label={`${name}: read`} />
        Read
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          className={boxClass}
          checked={write}
          disabled={disabled}
          aria-label={`${name}: act`}
          onChange={(event) => {
            const next = event.target.checked;
            onChange(next, next ? destructive : false);
          }}
        />
        Act
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          className={boxClass}
          checked={destructive}
          disabled={disabled || !write}
          aria-label={`${name}: destructive`}
          onChange={(event) => onChange(write, event.target.checked)}
        />
        Destructive
      </label>
    </span>
  );
}

export default function MirthConnector({
  tenantId,
  instances: initialInstances,
}: {
  tenantId: string;
  instances: ConnectableMirthInstanceView[];
}) {
  const [instances, setInstances] = useState(initialInstances);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchInstance = (instanceId: string, connection: MirthConnectionView | null) =>
    setInstances((current) =>
      current.map((instance) =>
        instance.id === instanceId ? { ...instance, connection } : instance
      )
    );

  const connect = async (instance: ConnectableMirthInstanceView) => {
    setBusy(true);
    setError(null);
    const saveError = await sendJson(
      `/api/tenant/${tenantId}/mirth/${instance.id}/connection`,
      'POST',
      {
        username: draft.username,
        password: draft.password,
        toolAccess: draft.write ? 'read_write' : 'read',
        allowDestructive: draft.write && draft.destructive,
      }
    );
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    patchInstance(instance.id, {
      username: draft.username,
      toolAccess: draft.write ? 'read_write' : 'read',
      allowDestructive: draft.write && draft.destructive,
    });
    setOpenId(null);
    setDraft(EMPTY_DRAFT);
  };

  const saveExposure = async (
    instance: ConnectableMirthInstanceView,
    write: boolean,
    destructive: boolean
  ) => {
    if (!instance.connection) return;
    const previous = instance.connection;
    // Controlled checkboxes must flip on click; an error rolls back.
    patchInstance(instance.id, {
      ...previous,
      toolAccess: write ? 'read_write' : 'read',
      allowDestructive: write && destructive,
    });
    setError(null);
    const saveError = await sendJson(
      `/api/tenant/${tenantId}/mirth/${instance.id}/connection`,
      'POST',
      { toolAccess: write ? 'read_write' : 'read', allowDestructive: write && destructive }
    );
    if (saveError) {
      setError(saveError);
      patchInstance(instance.id, previous);
    }
  };

  const disconnect = async (instance: ConnectableMirthInstanceView) => {
    if (
      !window.confirm(
        `Disconnect "${instance.name}"? Your stored Mirth credentials for it are deleted and its tools disappear.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const saveError = await sendJson(
      `/api/tenant/${tenantId}/mirth/${instance.id}/connection`,
      'DELETE'
    );
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    patchInstance(instance.id, null);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="text-base font-semibold">Mirth Connect</h2>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Your organization&apos;s Mirth Connect servers. Connect each with your own Mirth account —
        what you can reach there is what that account can. The checkboxes are what your LLM&apos;s
        tools may do (act: deploy, start/stop, send messages, edit configuration; destructive:
        delete channels, purge message stores); Mirth still has the final say.
      </p>

      <ul className="mt-3 space-y-3">
        {instances.map((instance) => (
          <li
            key={instance.id}
            className="rounded-md border border-gray-200 p-2.5 dark:border-gray-800"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                {instance.name}
                <span className="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs font-normal text-gray-600 dark:border-gray-700 dark:text-gray-400">
                  {instance.environment}
                </span>
                <span className="ml-2 font-mono text-xs font-normal text-gray-500 dark:text-gray-400">
                  {instance.baseUrl}
                </span>
              </span>
              {instance.connection ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void disconnect(instance)}
                  className="shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                >
                  Disconnect
                </button>
              ) : openId === instance.id ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setOpenId(instance.id);
                    setDraft(EMPTY_DRAFT);
                    setError(null);
                  }}
                  className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Connect
                </button>
              )}
            </div>

            {instance.connection ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Connected as <span className="font-mono">{instance.connection.username}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">LLM tools:</span>
                  <ExposureBoxes
                    name={`LLM tools on ${instance.name}`}
                    write={instance.connection.toolAccess === 'read_write'}
                    destructive={instance.connection.allowDestructive}
                    disabled={busy}
                    onChange={(write, destructive) =>
                      void saveExposure(instance, write, destructive)
                    }
                  />
                </span>
              </div>
            ) : null}

            {openId === instance.id && !instance.connection ? (
              <div className="mt-2 space-y-2 border-t border-gray-200 pt-2 dark:border-gray-800">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                    Mirth username
                    <input
                      autoFocus
                      autoComplete="off"
                      className={`${inputClass} mt-1 block w-full`}
                      value={draft.username}
                      onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                    />
                  </label>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                    Password
                    <input
                      type="password"
                      autoComplete="new-password"
                      className={`${inputClass} mt-1 block w-full`}
                      value={draft.password}
                      onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Let the LLM tools:
                    </span>
                    <ExposureBoxes
                      name={`LLM tools on ${instance.name}`}
                      write={draft.write}
                      destructive={draft.destructive}
                      disabled={busy}
                      onChange={(write, destructive) => setDraft({ ...draft, write, destructive })}
                    />
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setOpenId(null);
                        setError(null);
                      }}
                      className="rounded-md border border-gray-200 px-2.5 py-1 text-xs hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-900"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy || !draft.username || !draft.password}
                      onClick={() => void connect(instance)}
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy ? 'Checking credentials…' : 'Connect'}
                    </button>
                  </span>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
