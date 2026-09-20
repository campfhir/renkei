'use client';

/**
 * The Mirth Connect card on the connectors page — where a person connects
 * each of the org's Mirth servers (dev, test, prod…) with their OWN Mirth
 * account, the same gesture as the file-shares card. The admin registers
 * where a server lives; this card is who you are on it. Connecting
 * validates the credential against the live server before anything is
 * stored (a wrong password fails here, not later).
 *
 * The permission grid is the person's choice of what their LLM's tools
 * may do on that instance — named grants grouped by area (read channels,
 * deploy channels, delete messages, restore the server…), with presets
 * for the common shapes. A tick can hide access the person's Mirth
 * account holds; it can never add any — Mirth still judges every request
 * by the connected account.
 */

import { useState } from 'react';
import {
  DEFAULT_MIRTH_PERMISSIONS,
  MIRTH_PERMISSIONS,
  MIRTH_PERMISSION_GROUPS,
  MIRTH_PERMISSION_PRESETS,
  normalizePermissions,
  type MirthPermission,
} from '@renkei/connector-mirth/pure';
import { sendJson } from '@/lib/fetch-json';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { inputClass } from '../admin/mirth/instance-config-fields';

export interface MirthConnectionView {
  username: string;
  permissions: MirthPermission[];
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
  permissions: MirthPermission[];
}

const emptyDraft = (): ConnectDraft => ({
  username: '',
  password: '',
  permissions: [...DEFAULT_MIRTH_PERMISSIONS],
});

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * The permission grid: one row per area, its verbs as checkboxes, and the
 * presets above it. `Read` is not forced on — a person may grant deploy
 * without read if that is what they mean — but the presets all start
 * from the reads.
 */
export function PermissionGrid({
  name,
  value,
  disabled,
  onChange,
}: {
  name: string;
  value: MirthPermission[];
  disabled: boolean;
  onChange: (permissions: MirthPermission[]) => void;
}) {
  const toggle = (id: MirthPermission, on: boolean) =>
    onChange(normalizePermissions(on ? [...value, id] : value.filter((held) => held !== id)));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-gray-500 dark:text-gray-400">Presets:</span>
        {MIRTH_PERMISSION_PRESETS.map((preset) => {
          const active = sameSet(preset.permissions, value);
          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              title={preset.description}
              onClick={() => onChange([...preset.permissions])}
              className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 ${
                active
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {MIRTH_PERMISSION_GROUPS.map((group) => (
          <div key={group} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="w-28 shrink-0 text-xs font-medium text-gray-700 dark:text-gray-300">
              {group}
            </span>
            {MIRTH_PERMISSIONS.filter((permission) => permission.group === group).map(
              (permission) => (
                <label
                  key={permission.id}
                  title={permission.description}
                  className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-blue-600"
                    checked={value.includes(permission.id)}
                    disabled={disabled}
                    aria-label={`${name}: ${permission.label}`}
                    onChange={(event) => toggle(permission.id, event.target.checked)}
                  />
                  {permission.label.replace(/^(Read|Edit|Delete) /, (verb) => verb)}
                </label>
              )
            )}
          </div>
        ))}
      </div>
    </div>
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectDraft>(emptyDraft());
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
      { username: draft.username, password: draft.password, permissions: draft.permissions }
    );
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    patchInstance(instance.id, { username: draft.username, permissions: draft.permissions });
    setOpenId(null);
    setDraft(emptyDraft());
  };

  const savePermissions = async (
    instance: ConnectableMirthInstanceView,
    permissions: MirthPermission[]
  ) => {
    if (!instance.connection) return;
    const previous = instance.connection;
    // Controlled checkboxes must flip on click; an error rolls back.
    patchInstance(instance.id, { ...previous, permissions });
    setError(null);
    const saveError = await sendJson(
      `/api/tenant/${tenantId}/mirth/${instance.id}/connection`,
      'POST',
      { permissions }
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
    if (editingId === instance.id) setEditingId(null);
  };

  const summarize = (permissions: MirthPermission[]): string => {
    const preset = MIRTH_PERMISSION_PRESETS.find((candidate) =>
      sameSet(candidate.permissions, permissions)
    );
    if (preset) return preset.label;
    if (permissions.length === 0) return 'No permissions';
    return `${permissions.length} of ${MIRTH_PERMISSIONS.length} permissions`;
  };

  const cardAnchor = useCoachAnchor('card-mirth');
  const listAnchor = useCoachAnchor('mirth-list');

  return (
    <div
      {...cardAnchor}
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h2 className="text-base font-semibold">Mirth Connect</h2>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Your organization&apos;s Mirth Connect servers. Connect each with your own Mirth account —
        what you can reach there is what that account can. The permissions are what your LLM&apos;s
        tools may do on that server; Mirth still has the final say.
      </p>

      <ul {...listAnchor} className="mt-3 space-y-3">
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
                    setDraft(emptyDraft());
                    setError(null);
                  }}
                  className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Connect
                </button>
              )}
            </div>

            {instance.connection ? (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    Connected as <span className="font-mono">{instance.connection.username}</span>
                    <span className="ml-2">
                      · LLM tools: {summarize(instance.connection.permissions)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingId(editingId === instance.id ? null : instance.id)}
                    className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {editingId === instance.id ? 'Done' : 'Change permissions'}
                  </button>
                </div>
                {editingId === instance.id ? (
                  <div className="border-t border-gray-200 pt-2 dark:border-gray-800">
                    <PermissionGrid
                      name={`LLM tools on ${instance.name}`}
                      value={instance.connection.permissions}
                      disabled={busy}
                      onChange={(permissions) => void savePermissions(instance, permissions)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {openId === instance.id && !instance.connection ? (
              <div className="mt-2 space-y-3 border-t border-gray-200 pt-2 dark:border-gray-800">
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
                <div>
                  <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
                    Let the LLM tools on this server:
                  </p>
                  <PermissionGrid
                    name={`LLM tools on ${instance.name}`}
                    value={draft.permissions}
                    disabled={busy}
                    onChange={(permissions) => setDraft({ ...draft, permissions })}
                  />
                </div>
                <div className="flex justify-end gap-2">
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
