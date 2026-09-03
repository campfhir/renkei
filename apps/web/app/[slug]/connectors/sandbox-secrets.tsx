'use client';

/**
 * The browser-secrets card on the connectors page — where a person hands
 * the sandbox browser a login it may TYPE on their behalf without the
 * model ever seeing it. Adding one asks for a name, the hosts it may be
 * typed on, and its fields (username/password by default); Renkei seals
 * it under a passphrase it generates and shows ONCE here — copy it into a
 * password manager, because unlocking again later needs it and nothing
 * in Renkei stores it. A secret starts unlocked for the window chosen
 * and locks itself when that lapses (or on Lock, or when the worker
 * restarts); Revoke deletes it. None of this is reachable through MCP.
 */

import { useState } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import { inputClass } from '../admin/file-shares/share-config-fields';

export interface SecretView {
  id: string;
  name: string;
  fields: string[];
  hosts: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  unlockedUntil: string | null;
}

interface FieldDraft {
  name: string;
  value: string;
}

interface CreateDraft {
  name: string;
  hosts: string;
  fields: FieldDraft[];
  ownPassphrase: boolean;
  passphrase: string;
  unlockHours: number;
  ttlDays: number;
}

const EMPTY_DRAFT: CreateDraft = {
  name: '',
  hosts: '',
  fields: [
    { name: 'username', value: '' },
    { name: 'password', value: '' },
  ],
  ownPassphrase: false,
  passphrase: '',
  unlockHours: 8,
  ttlDays: 30,
};

const UNLOCK_CHOICES = [1, 4, 8, 24];

function when(value: string): string {
  return new Date(value).toLocaleString();
}

function isUnlocked(secret: SecretView): boolean {
  return secret.unlockedUntil !== null && new Date(secret.unlockedUntil).getTime() > Date.now();
}

export default function SandboxSecrets({
  tenantId,
  secrets: initialSecrets,
}: {
  tenantId: string;
  secrets: SecretView[];
}) {
  const [secrets, setSecrets] = useState(initialSecrets);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The generated passphrase of the secret just created — shown once, then gone. */
  const [revealed, setRevealed] = useState<{ name: string; passphrase: string } | null>(null);
  const [unlocking, setUnlocking] = useState<{
    id: string;
    passphrase: string;
    hours: number;
  } | null>(null);

  const base = `/api/tenant/${tenantId}/sandbox/secrets`;

  const refresh = async () => {
    const listed = await getJson<{ secrets: SecretView[] }>(base);
    if (listed.data) setSecrets(listed.data.secrets);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const fields: Record<string, string> = {};
    for (const field of draft.fields) {
      if (field.name.trim()) fields[field.name.trim()] = field.value;
    }
    const result = await sendJsonFull<{ secret: SecretView; passphrase: string | null }>(
      base,
      'POST',
      {
        name: draft.name,
        hosts: draft.hosts,
        fields,
        ...(draft.ownPassphrase ? { passphrase: draft.passphrase } : {}),
        unlockHours: draft.unlockHours,
        ttlDays: draft.ttlDays,
      }
    );
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'Could not store the secret');
      return;
    }
    setSecrets((current) =>
      [...current, result.data!.secret].sort((a, b) => a.name.localeCompare(b.name))
    );
    if (result.data.passphrase) {
      setRevealed({ name: result.data.secret.name, passphrase: result.data.passphrase });
    }
    setAdding(false);
    setDraft(EMPTY_DRAFT);
  };

  const unlock = async () => {
    if (!unlocking) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ secret: SecretView }>(`${base}/${unlocking.id}`, 'POST', {
      action: 'unlock',
      passphrase: unlocking.passphrase,
      unlockHours: unlocking.hours,
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'Could not unlock the secret');
      return;
    }
    const updated = result.data.secret;
    setSecrets((current) => current.map((secret) => (secret.id === updated.id ? updated : secret)));
    setUnlocking(null);
  };

  const lock = async (secret: SecretView) => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ secret: SecretView }>(`${base}/${secret.id}`, 'POST', {
      action: 'lock',
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'Could not lock the secret');
      return;
    }
    const updated = result.data.secret;
    setSecrets((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
  };

  const revoke = async (secret: SecretView) => {
    if (
      !window.confirm(
        `Revoke "${secret.name}"? It is deleted and the browser can no longer type it.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const saveError = await sendJson(`${base}/${secret.id}`, 'DELETE');
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setSecrets((current) => current.filter((entry) => entry.id !== secret.id));
  };

  const setField = (index: number, patch: Partial<FieldDraft>) =>
    setDraft({
      ...draft,
      fields: draft.fields.map((field, at) => (at === index ? { ...field, ...patch } : field)),
    });

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Browser secrets</h2>
        {adding ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setAdding(true);
              setDraft(EMPTY_DRAFT);
              setError(null);
              setRevealed(null);
            }}
            className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Add secret
          </button>
        )}
      </div>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Logins your agents&apos; sandbox browser may type on named sites — the model never sees the
        values, only that a secret exists. Each is sealed under its own passphrase (not
        Renkei&apos;s keys), stays unlocked only for the window you choose, and expires on its own.
      </p>

      {revealed ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
          <p className="font-medium">
            Passphrase for <span className="font-mono">{revealed.name}</span> — shown once
          </p>
          <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">
            Renkei does not keep this. Save it in your password manager; you will need it to unlock
            the secret again after it locks.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="select-all rounded bg-white px-2 py-1 font-mono text-sm dark:bg-gray-900">
              {revealed.passphrase}
            </code>
            <button
              type="button"
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => void navigator.clipboard?.writeText(revealed.passphrase)}
            >
              Copy
            </button>
            <button
              type="button"
              className="text-xs text-gray-500 hover:underline dark:text-gray-400"
              onClick={() => setRevealed(null)}
            >
              I saved it
            </button>
          </div>
        </div>
      ) : null}

      {adding ? (
        <div className="mt-3 space-y-2 rounded-md border border-gray-200 p-2.5 dark:border-gray-800">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Name (what the agent refers to)
              <input
                autoFocus
                autoComplete="off"
                placeholder="vendor-portal"
                className={`${inputClass} mt-1 block w-full`}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Hosts it may be typed on
              <input
                autoComplete="off"
                placeholder="portal.vendor.com, *.vendor.com"
                className={`${inputClass} mt-1 block w-full`}
                value={draft.hosts}
                onChange={(event) => setDraft({ ...draft, hosts: event.target.value })}
              />
            </label>
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Fields
            </span>
            {draft.fields.map((field, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  autoComplete="off"
                  aria-label={`Field ${index + 1} name`}
                  placeholder="field"
                  className={`${inputClass} w-36 font-mono text-xs`}
                  value={field.name}
                  onChange={(event) => setField(index, { name: event.target.value })}
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  aria-label={`Field ${index + 1} value`}
                  placeholder="value"
                  className={`${inputClass} min-w-0 flex-1`}
                  value={field.value}
                  onChange={(event) => setField(index, { value: event.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Remove field ${index + 1}`}
                  disabled={draft.fields.length <= 1}
                  className="text-xs text-gray-500 hover:underline disabled:opacity-40 dark:text-gray-400"
                  onClick={() =>
                    setDraft({ ...draft, fields: draft.fields.filter((_, at) => at !== index) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            {draft.fields.length < 8 ? (
              <button
                type="button"
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                onClick={() =>
                  setDraft({ ...draft, fields: [...draft.fields, { name: '', value: '' }] })
                }
              >
                Add field
              </button>
            ) : null}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Unlocked for
              <select
                className={`${inputClass} mt-1 block w-full`}
                value={draft.unlockHours}
                onChange={(event) =>
                  setDraft({ ...draft, unlockHours: Number(event.target.value) })
                }
              >
                {UNLOCK_CHOICES.map((hours) => (
                  <option key={hours} value={hours}>
                    {hours} hour{hours === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Expires after
              <select
                className={`${inputClass} mt-1 block w-full`}
                value={draft.ttlDays}
                onChange={(event) => setDraft({ ...draft, ttlDays: Number(event.target.value) })}
              >
                {[7, 30, 90].map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-end gap-1.5 pb-2 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                className="h-4 w-4 accent-blue-600"
                checked={draft.ownPassphrase}
                onChange={(event) => setDraft({ ...draft, ownPassphrase: event.target.checked })}
              />
              I&apos;ll choose the passphrase
            </label>
          </div>
          {draft.ownPassphrase ? (
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Passphrase (12+ characters; Renkei will not store it)
              <input
                type="password"
                autoComplete="new-password"
                className={`${inputClass} mt-1 block w-full`}
                value={draft.passphrase}
                onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })}
              />
            </label>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Renkei will generate a strong passphrase and show it once.
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !draft.name || !draft.hosts}
              onClick={() => void create()}
              className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Store secret
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setDraft(EMPTY_DRAFT);
                setError(null);
              }}
              className="text-xs text-gray-500 hover:underline dark:text-gray-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {secrets.length === 0 && !adding ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No secrets stored.</p>
      ) : null}

      <ul className="mt-3 space-y-3">
        {secrets.map((secret) => {
          const unlocked = isUnlocked(secret);
          return (
            <li
              key={secret.id}
              className="rounded-md border border-gray-200 p-2.5 dark:border-gray-800"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  <span className="font-mono">{secret.name}</span>
                  <span
                    className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      unlocked
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                    }`}
                  >
                    {unlocked ? `Unlocked until ${when(secret.unlockedUntil!)}` : 'Locked'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {unlocked ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void lock(secret)}
                      className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                    >
                      Lock
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setUnlocking({ id: secret.id, passphrase: '', hours: 8 });
                        setError(null);
                      }}
                      className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                    >
                      Unlock
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(secret)}
                    className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                  >
                    Revoke
                  </button>
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Fields: <span className="font-mono">{secret.fields.join(', ')}</span> · Hosts:{' '}
                <span className="font-mono">{secret.hosts.join(', ')}</span> · Expires{' '}
                {when(secret.expiresAt)}
                {secret.lastUsedAt ? ` · Last typed ${when(secret.lastUsedAt)}` : ''}
              </p>

              {unlocking?.id === secret.id ? (
                <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-gray-200 pt-2 dark:border-gray-800">
                  <label className="block min-w-0 flex-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                    Passphrase
                    <input
                      autoFocus
                      type="password"
                      autoComplete="off"
                      className={`${inputClass} mt-1 block w-full`}
                      value={unlocking.passphrase}
                      onChange={(event) =>
                        setUnlocking({ ...unlocking, passphrase: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void unlock();
                      }}
                    />
                  </label>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                    For
                    <select
                      className={`${inputClass} mt-1 block`}
                      value={unlocking.hours}
                      onChange={(event) =>
                        setUnlocking({ ...unlocking, hours: Number(event.target.value) })
                      }
                    >
                      {UNLOCK_CHOICES.map((hours) => (
                        <option key={hours} value={hours}>
                          {hours} hour{hours === 1 ? '' : 's'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={busy || !unlocking.passphrase}
                    onClick={() => void unlock()}
                    className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Unlock
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setUnlocking(null)}
                    className="text-xs text-gray-500 hover:underline dark:text-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      {secrets.length > 0 ? (
        <button
          type="button"
          className="mt-2 text-xs text-gray-500 hover:underline dark:text-gray-400"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      ) : null}
    </div>
  );
}
