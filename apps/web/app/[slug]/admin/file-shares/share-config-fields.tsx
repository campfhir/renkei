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
  enabled: boolean;
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
    enabled: true,
  };
}

/** What the admin routes accept. */
export function draftPayload(draft: ShareDraft): Record<string, unknown> {
  return {
    name: draft.name,
    protocol: draft.protocol,
    host: draft.host,
    port: draft.port ? Number(draft.port) : null,
    shareName: draft.shareName || undefined,
    rootPath: draft.rootPath,
    caseInsensitive: draft.caseInsensitive,
    enabled: draft.enabled,
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
}: {
  draft: ShareDraft;
  onChange: (draft: ShareDraft) => void;
}) {
  const set = (patch: Partial<ShareDraft>) => onChange({ ...draft, ...patch });
  const preview = pathPreview(draft.rootPath);

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
