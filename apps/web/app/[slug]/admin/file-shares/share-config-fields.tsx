'use client';

/**
 * The share config form fields, shared by the create form (list page) and
 * the edit form (detail page) so the two can never drift. Pure controlled
 * fields over a ShareDraft; the credential inputs are WRITE-ONLY — they
 * start empty even when a credential is stored, and leaving them empty
 * means "keep what is saved" (the placeholder says so).
 *
 * The root path input translates pasted Windows/UNC spellings live via
 * the same functions the server validates with, so the preview is honest.
 */

import { normalizePath, windowsToUnix } from '@renkei/connector-fileshares/pure';

export const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export interface ShareDraft {
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  port: string;
  shareName: string;
  rootPath: string;
  caseInsensitive: boolean;
  maxAccess: 'read' | 'read_write';
  enabled: boolean;
  username: string;
  password: string;
  domain: string;
  privateKey: string;
  passphrase: string;
}

export function emptyDraft(): ShareDraft {
  return {
    name: '',
    protocol: 'smb',
    host: '',
    port: '',
    shareName: '',
    rootPath: '/',
    caseInsensitive: true,
    maxAccess: 'read',
    enabled: true,
    username: '',
    password: '',
    domain: '',
    privateKey: '',
    passphrase: '',
  };
}

/** What the admin routes accept — credential fields only when filled. */
export function draftPayload(draft: ShareDraft): Record<string, unknown> {
  return {
    name: draft.name,
    protocol: draft.protocol,
    host: draft.host,
    port: draft.port ? Number(draft.port) : null,
    shareName: draft.shareName || undefined,
    rootPath: draft.rootPath,
    caseInsensitive: draft.caseInsensitive,
    maxAccess: draft.maxAccess,
    enabled: draft.enabled,
    ...(draft.username ? { username: draft.username } : {}),
    ...(draft.password ? { password: draft.password } : {}),
    ...(draft.domain ? { domain: draft.domain } : {}),
    ...(draft.privateKey ? { privateKey: draft.privateKey } : {}),
    ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
  };
}

/** The live translation the server will apply to the root path. */
export function pathPreview(raw: string): { text: string; error: boolean } {
  const normalized = normalizePath(windowsToUnix(raw || '/'));
  if (!normalized.ok)
    return { text: 'This path climbs upward ("..") and will be rejected.', error: true };
  return { text: `Stored as ${normalized.val}`, error: false };
}

export default function ShareConfigFields({
  draft,
  onChange,
  hasStoredCredentials,
}: {
  draft: ShareDraft;
  onChange: (draft: ShareDraft) => void;
  /** True on the edit form when a credential is already sealed away. */
  hasStoredCredentials: boolean;
}) {
  const set = (patch: Partial<ShareDraft>) => onChange({ ...draft, ...patch });
  const preview = pathPreview(draft.rootPath);
  const credentialPlaceholder = hasStoredCredentials ? '•••••• (saved — leave blank to keep)' : '';

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Name
          <input
            className={`${inputClass} mt-1 block w-full`}
            value={draft.name}
            placeholder="e.g. Accounting share"
            onChange={(event) => set({ name: event.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Protocol
          <select
            className={`${inputClass} mt-1 block w-full`}
            value={draft.protocol}
            onChange={(event) =>
              set(
                event.target.value === 'sftp'
                  ? { protocol: 'sftp', caseInsensitive: false }
                  : { protocol: 'smb', caseInsensitive: true }
              )
            }
          >
            <option value="smb">SMB (Windows share, \\host\share)</option>
            <option value="sftp">SFTP</option>
          </select>
        </label>
        <label className="block text-sm font-medium">
          Host
          <input
            className={`${inputClass} mt-1 block w-full`}
            value={draft.host}
            placeholder="fileserver.corp.example"
            onChange={(event) => set({ host: event.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Port
          <input
            className={`${inputClass} mt-1 block w-full`}
            value={draft.port}
            placeholder={draft.protocol === 'smb' ? '445 (default)' : '22 (default)'}
            onChange={(event) => set({ port: event.target.value })}
          />
        </label>
        {draft.protocol === 'smb' ? (
          <label className="block text-sm font-medium">
            Share name
            <input
              className={`${inputClass} mt-1 block w-full`}
              value={draft.shareName}
              placeholder="the share in \\host\share"
              onChange={(event) => set({ shareName: event.target.value })}
            />
          </label>
        ) : null}
        <label className="block text-sm font-medium">
          Root path
          <input
            className={`${inputClass} mt-1 block w-full`}
            value={draft.rootPath}
            placeholder={draft.protocol === 'smb' ? '\\ or a subfolder' : '/srv/data'}
            onChange={(event) => set({ rootPath: event.target.value })}
          />
          <span
            className={`mt-1 block text-xs font-normal ${preview.error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {preview.text} — Windows paths (\\server\share\folder, C:\folder) are translated.
          </span>
        </label>
        <label className="block text-sm font-medium">
          Share-wide ceiling
          <select
            className={`${inputClass} mt-1 block w-full`}
            value={draft.maxAccess}
            onChange={(event) =>
              set({ maxAccess: event.target.value === 'read_write' ? 'read_write' : 'read' })
            }
          >
            <option value="read">Read only</option>
            <option value="read_write">Read and write</option>
          </select>
        </label>
        <label className="mt-6 flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={draft.caseInsensitive}
            onChange={(event) => set({ caseInsensitive: event.target.checked })}
          />
          Match rule paths case-insensitively
        </label>
      </div>

      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <p className="text-sm font-medium">Service credential</p>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          Stored encrypted; used only server-side. Renkei&apos;s own grants decide who may use it.
          {hasStoredCredentials ? ' Leave every field blank to keep the saved credential.' : ''}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Username
            <input
              className={`${inputClass} mt-1 block w-full`}
              value={draft.username}
              placeholder={credentialPlaceholder}
              autoComplete="off"
              onChange={(event) => set({ username: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              type="password"
              className={`${inputClass} mt-1 block w-full`}
              value={draft.password}
              placeholder={credentialPlaceholder}
              autoComplete="new-password"
              onChange={(event) => set({ password: event.target.value })}
            />
          </label>
          {draft.protocol === 'smb' ? (
            <label className="block text-sm font-medium">
              Domain (optional)
              <input
                className={`${inputClass} mt-1 block w-full`}
                value={draft.domain}
                autoComplete="off"
                onChange={(event) => set({ domain: event.target.value })}
              />
            </label>
          ) : (
            <>
              <label className="block text-sm font-medium sm:col-span-2">
                Private key (optional, instead of a password)
                <textarea
                  className={`${inputClass} mt-1 block h-24 w-full font-mono text-xs`}
                  value={draft.privateKey}
                  placeholder={
                    hasStoredCredentials ? credentialPlaceholder : '-----BEGIN ... KEY-----'
                  }
                  onChange={(event) => set({ privateKey: event.target.value })}
                />
              </label>
              <label className="block text-sm font-medium">
                Key passphrase (optional)
                <input
                  type="password"
                  className={`${inputClass} mt-1 block w-full`}
                  value={draft.passphrase}
                  autoComplete="new-password"
                  onChange={(event) => set({ passphrase: event.target.value })}
                />
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
