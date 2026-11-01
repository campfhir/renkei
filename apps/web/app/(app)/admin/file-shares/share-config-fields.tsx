'use client';

/**
 * The share config form fields, shared by the create form (list page) and
 * the edit form (detail page) so the two can never drift. Pure controlled
 * fields over a ShareDraft — connection details only: no credential ever
 * appears on the admin surface, because every person connects a share with
 * their own account from the connectors page.
 *
 * The root path input translates pasted Windows/UNC spellings live via
 * the same functions the server validates with, so the preview is honest.
 */

import {
  hostKeyPreview,
  pathPreview,
  portPlaceholder,
  rootPathPlaceholder,
  visibleFields,
  type ShareDraft,
} from './share-config-fields.model';

export const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function ShareConfigFields({
  draft,
  onChange,
}: {
  draft: ShareDraft;
  /** A change to the draft; the model's editDraft applies it. */
  onChange: (patch: Partial<ShareDraft>) => void;
}) {
  const set = onChange;
  const shows = visibleFields(draft.protocol);
  const preview = pathPreview(draft.rootPath);
  const hostKey = hostKeyPreview(draft.hostKeyFingerprint);

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
            onChange={(event) => set({ protocol: event.target.value === 'sftp' ? 'sftp' : 'smb' })}
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
            placeholder={portPlaceholder(draft.protocol)}
            onChange={(event) => set({ port: event.target.value })}
          />
        </label>
        {shows.shareName ? (
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
            placeholder={rootPathPlaceholder(draft.protocol)}
            onChange={(event) => set({ rootPath: event.target.value })}
          />
          <span
            className={`mt-1 block text-xs font-normal ${preview.error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {preview.text} — Windows paths (\\server\share\folder, C:\folder) are translated.
          </span>
        </label>
        {shows.hostKey ? (
          <label className="block text-sm font-medium sm:col-span-2">
            Host key fingerprint (SHA256)
            <input
              className={`${inputClass} mt-1 block w-full font-mono`}
              value={draft.hostKeyFingerprint}
              placeholder="SHA256:… from ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
              spellCheck={false}
              onChange={(event) => set({ hostKeyFingerprint: event.target.value })}
            />
            <span
              className={`mt-1 block text-xs font-normal ${hostKey.error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
            >
              {hostKey.text}
            </span>
          </label>
        ) : null}
        <label className="mt-6 flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={draft.caseInsensitive}
            onChange={(event) => set({ caseInsensitive: event.target.checked })}
          />
          Paths on this server match case-insensitively
        </label>
      </div>
    </div>
  );
}
