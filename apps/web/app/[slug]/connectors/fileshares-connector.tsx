'use client';

/**
 * The file-shares card on the connectors page — where a person connects an
 * org share with their OWN credentials, the same gesture as every OAuth
 * card. The admin registers where a share lives; this card is who you are
 * on it. Connecting validates the credential against the live file server
 * before anything is stored (a wrong password fails here, not later), and
 * the two checkboxes are the person's LLM-exposure choice: whether the
 * model's tools may write, and separately whether they may delete. Reading
 * is what a connection is for, so it is always on; the file server still
 * judges every operation by the connected account.
 */

import { useState } from 'react';
import { sendJson } from '@/lib/fetch-json';
import { inputClass } from '../admin/file-shares/share-config-fields';

export interface ShareConnectionView {
  username: string;
  toolAccess: 'read' | 'read_write';
  allowDelete: boolean;
}

export interface ConnectableShareView {
  id: string;
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  shareName: string | null;
  connection: ShareConnectionView | null;
}

interface ConnectDraft {
  username: string;
  password: string;
  domain: string;
  privateKey: string;
  passphrase: string;
  write: boolean;
  del: boolean;
}

const EMPTY_DRAFT: ConnectDraft = {
  username: '',
  password: '',
  domain: '',
  privateKey: '',
  passphrase: '',
  write: false,
  del: false,
};

function targetOf(share: ConnectableShareView): string {
  return share.protocol === 'smb'
    ? `smb://${share.host}/${share.shareName ?? ''}`
    : `sftp://${share.host}`;
}

/** The exposure checkbox pair, shared by the connect form and the row. */
function ExposureBoxes({
  name,
  write,
  del,
  disabled,
  onChange,
}: {
  name: string;
  write: boolean;
  del: boolean;
  disabled: boolean;
  onChange: (write: boolean, del: boolean) => void;
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
          aria-label={`${name}: write`}
          onChange={(event) => {
            const next = event.target.checked;
            onChange(next, next ? del : false);
          }}
        />
        Write
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          className={boxClass}
          checked={del}
          disabled={disabled || !write}
          aria-label={`${name}: delete`}
          onChange={(event) => onChange(write, event.target.checked)}
        />
        Delete
      </label>
    </span>
  );
}

export default function FilesharesConnector({
  tenantId,
  shares: initialShares,
}: {
  tenantId: string;
  shares: ConnectableShareView[];
}) {
  const [shares, setShares] = useState(initialShares);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchShare = (shareId: string, connection: ShareConnectionView | null) =>
    setShares((current) =>
      current.map((share) => (share.id === shareId ? { ...share, connection } : share))
    );

  const connect = async (share: ConnectableShareView) => {
    setBusy(true);
    setError(null);
    const saveError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/connection`,
      'POST',
      {
        username: draft.username,
        password: draft.password,
        ...(draft.domain ? { domain: draft.domain } : {}),
        ...(draft.privateKey ? { privateKey: draft.privateKey } : {}),
        ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
        toolAccess: draft.write ? 'read_write' : 'read',
        allowDelete: draft.write && draft.del,
      }
    );
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    patchShare(share.id, {
      username: draft.username,
      toolAccess: draft.write ? 'read_write' : 'read',
      allowDelete: draft.write && draft.del,
    });
    setOpenId(null);
    setDraft(EMPTY_DRAFT);
  };

  const saveExposure = async (share: ConnectableShareView, write: boolean, del: boolean) => {
    if (!share.connection) return;
    const previous = share.connection;
    // Controlled checkboxes must flip on click; an error rolls back.
    patchShare(share.id, {
      ...previous,
      toolAccess: write ? 'read_write' : 'read',
      allowDelete: write && del,
    });
    setError(null);
    const saveError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/connection`,
      'POST',
      { toolAccess: write ? 'read_write' : 'read', allowDelete: write && del }
    );
    if (saveError) {
      setError(saveError);
      patchShare(share.id, previous);
    }
  };

  const disconnect = async (share: ConnectableShareView) => {
    if (
      !window.confirm(
        `Disconnect "${share.name}"? Your stored credentials for it are deleted and its tools disappear.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const saveError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/connection`,
      'DELETE'
    );
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    patchShare(share.id, null);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="text-base font-semibold">File shares</h2>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Org network shares (SMB/SFTP). Connect each with your own file-server account — what you can
        reach there is what that account can. The checkboxes are what your LLM&apos;s tools may do;
        the servers still have the final say.
      </p>

      <ul className="mt-3 space-y-3">
        {shares.map((share) => (
          <li
            key={share.id}
            className="rounded-md border border-gray-200 p-2.5 dark:border-gray-800"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                {share.name}
                <span className="ml-2 font-mono text-xs font-normal text-gray-500 dark:text-gray-400">
                  {targetOf(share)}
                </span>
              </span>
              {share.connection ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void disconnect(share)}
                  className="shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                >
                  Disconnect
                </button>
              ) : openId === share.id ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setOpenId(share.id);
                    setDraft(EMPTY_DRAFT);
                    setError(null);
                  }}
                  className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Connect
                </button>
              )}
            </div>

            {share.connection ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Connected as <span className="font-mono">{share.connection.username}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">LLM tools:</span>
                  <ExposureBoxes
                    name={`LLM tools on ${share.name}`}
                    write={share.connection.toolAccess === 'read_write'}
                    del={share.connection.allowDelete}
                    disabled={busy}
                    onChange={(write, del) => void saveExposure(share, write, del)}
                  />
                </span>
              </div>
            ) : null}

            {openId === share.id && !share.connection ? (
              <div className="mt-2 space-y-2 border-t border-gray-200 pt-2 dark:border-gray-800">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                    Username
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
                  {share.protocol === 'smb' ? (
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Domain (optional)
                      <input
                        autoComplete="off"
                        className={`${inputClass} mt-1 block w-full`}
                        value={draft.domain}
                        onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
                      />
                    </label>
                  ) : (
                    <>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 sm:col-span-2">
                        Private key (optional, instead of a password)
                        <textarea
                          className={`${inputClass} mt-1 block h-20 w-full font-mono text-xs`}
                          placeholder="-----BEGIN ... KEY-----"
                          value={draft.privateKey}
                          onChange={(event) =>
                            setDraft({ ...draft, privateKey: event.target.value })
                          }
                        />
                      </label>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Key passphrase (optional)
                        <input
                          type="password"
                          autoComplete="new-password"
                          className={`${inputClass} mt-1 block w-full`}
                          value={draft.passphrase}
                          onChange={(event) =>
                            setDraft({ ...draft, passphrase: event.target.value })
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Let the LLM tools:
                    </span>
                    <ExposureBoxes
                      name={`LLM tools on ${share.name}`}
                      write={draft.write}
                      del={draft.del}
                      disabled={busy}
                      onChange={(write, del) => setDraft({ ...draft, write, del })}
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
                      disabled={busy || !draft.username || (!draft.password && !draft.privateKey)}
                      onClick={() => void connect(share)}
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
