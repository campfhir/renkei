'use client';

import { useState, type FormEvent } from 'react';
import { sendJsonFull } from '@/lib/fetch-json';
import type { StorageView } from '@/lib/storage-admin';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

export default function StorageForm({
  slug,
  initial,
}: {
  slug: string;
  initial: StorageView | null;
}) {
  const [view, setView] = useState<StorageView | null>(initial);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [account, setAccount] = useState(initial?.account ?? '');
  const [container, setContainer] = useState(initial?.container ?? 'renkei-chat');
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const payload = { enabled, account, container, endpoint: endpoint || null, key: key || null };

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setNotice(null);
    setError(null);
    const result = await sendJsonFull<StorageView>(`/api/admin/${slug}/storage`, 'PUT', payload);
    setBusy(null);
    if (result.error || !result.data) {
      setError(result.error ?? 'The configuration could not be saved.');
      return;
    }
    setView(result.data);
    setKey('');
    setNotice('Saved.');
  }

  async function test() {
    setBusy('test');
    setNotice(null);
    setError(null);
    const result = await sendJsonFull<{ ok: boolean; detail: string }>(
      `/api/admin/${slug}/storage/test-connection`,
      'POST',
      payload
    );
    setBusy(null);
    if (result.error || !result.data) {
      setError(result.error ?? 'The test could not run.');
      return;
    }
    if (result.data.ok) setNotice(result.data.detail);
    else setError(result.data.detail);
  }

  return (
    <form
      onSubmit={save}
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="font-semibold">Azure Blob Storage</h2>
        {view?.configured ? (
          view.enabled ? (
            <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
              Enabled
            </span>
          ) : (
            <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
              Disabled
            </span>
          )
        ) : view?.environmentFallback ? (
          <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
            From the deployment
          </span>
        ) : (
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
            Not configured
          </span>
        )}
      </div>
      {!view?.configured && view?.environmentFallback ? (
        <p className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200">
          This deployment carries a storage account in its environment, and the organization is
          using it. Saving one here takes precedence.
        </p>
      ) : null}
      <div className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="storage-account">
            Storage account
          </label>
          <input
            id="storage-account"
            className={inputClass}
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            placeholder="contosofiles"
            autoComplete="off"
            required
          />
          <p className={hintClass}>The account name, as in {'{account}'}.blob.core.windows.net.</p>
        </div>
        <div>
          <label className={labelClass} htmlFor="storage-key">
            Account key
          </label>
          <input
            id="storage-key"
            type="password"
            className={inputClass}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={view?.hasKey ? '•••••••• (stored; leave blank to keep)' : 'base64 key'}
            autoComplete="new-password"
          />
          <p className={hintClass}>
            One of the account&apos;s two shared keys. Sealed at rest; a blank field keeps the
            stored key.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="storage-container">
              Container
            </label>
            <input
              id="storage-container"
              className={inputClass}
              value={container}
              onChange={(event) => setContainer(event.target.value)}
              placeholder="renkei-chat"
            />
            <p className={hintClass}>Created on first use if it does not exist.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="storage-endpoint">
              Endpoint (optional)
            </label>
            <input
              id="storage-endpoint"
              className={inputClass}
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://contosofiles.blob.core.windows.net"
            />
            <p className={hintClass}>
              For a sovereign cloud, an emulator, or a Front Door / private domain that forwards to
              the account (see DEPLOYMENT.md, &ldquo;Storage behind Azure Front Door&rdquo;).
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy !== null}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={busy !== null}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        {notice && <span className="text-sm text-green-700 dark:text-green-300">{notice}</span>}
        {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </form>
  );
}
