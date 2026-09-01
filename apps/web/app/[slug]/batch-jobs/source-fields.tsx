'use client';

/**
 * The share/folder/grouping fields document-ocr-pipeline needs — shared by
 * the one-off "new batch job" form and the "new/edit schedule" form so the
 * two cannot drift on what's asked for or how it's validated. Fully
 * controlled (value/onChange per field), the same shape as ScheduleEditor
 * in the agent builder — the caller owns the state, this just renders it.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getJson } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';
import FolderPicker from './new/folder-picker';

export type GroupingStrategy = 'whole-file' | 'filename-pattern';

interface ShareView {
  id: string;
  name: string;
  connection: { username: string } | null;
}

export const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
export const labelClass = 'block text-sm font-medium mb-1';
export const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/** A regex must compile AND carry both named captures document-ocr-pipeline requires. */
export function validateGroupingPattern(pattern: string): string | null {
  if (!pattern.trim()) return 'A pattern is required for filename-pattern grouping.';
  if (!pattern.includes('?<documentKey>') || !pattern.includes('?<page>')) {
    return 'The pattern must have named capture groups ?<documentKey> and ?<page>.';
  }
  try {
    new RegExp(pattern);
  } catch {
    return 'Not a valid regular expression.';
  }
  return null;
}

export default function SourceFields({
  slug,
  tenantId,
  shareId,
  path,
  strategy,
  pattern,
  onShareIdChange,
  onPathChange,
  onStrategyChange,
  onPatternChange,
  onReadyChange,
}: {
  slug: string;
  tenantId: string;
  shareId: string;
  path: string;
  strategy: GroupingStrategy;
  pattern: string;
  onShareIdChange: (shareId: string) => void;
  onPathChange: (path: string) => void;
  onStrategyChange: (strategy: GroupingStrategy) => void;
  onPatternChange: (pattern: string) => void;
  /** Fires whenever "is there at least one connected share to pick" changes. */
  onReadyChange?: (ready: boolean) => void;
}) {
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data, error: fetchError } = await getJson<{ shares: ShareView[] }>(
        `/api/tenant/${tenantId}/fileshares`
      );
      if (fetchError) setLoadError(fetchError);
      else setShares(data?.shares ?? []);
    })();
  }, [tenantId]);

  const connectedShares = (shares ?? []).filter((share) => share.connection !== null);

  useEffect(() => {
    onReadyChange?.(shares !== null && connectedShares.length > 0);
    // connectedShares is derived fresh from `shares` on every render, so
    // depending on `shares` alone already re-fires whenever it would.
  }, [shares]);
  const unconnectedCount = (shares ?? []).length - connectedShares.length;
  const patternError = strategy === 'filename-pattern' ? validateGroupingPattern(pattern) : null;
  const selectedShare = connectedShares.find((share) => share.id === shareId) ?? null;

  function chooseShare(nextShareId: string) {
    onShareIdChange(nextShareId);
    // A path picked in one share means nothing in another.
    onPathChange('/');
  }

  if (loadError) {
    return <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>;
  }

  return (
    <>
      <div>
        <label htmlFor="bj-share" className={labelClass}>
          File share
        </label>
        {shares === null ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading your file shares…</p>
        ) : connectedShares.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You have not connected a file share yet. Connect one on the{' '}
            <Link href={`/${slug}/connectors`} className="text-blue-600 hover:underline dark:text-blue-400">
              Connectors page
            </Link>{' '}
            first.
          </p>
        ) : (
          <>
            <select
              id="bj-share"
              required
              value={shareId}
              onChange={(e) => chooseShare(e.target.value)}
              className={inputClass}
            >
              <option value="" disabled>
                Choose a share…
              </option>
              {connectedShares.map((share) => (
                <option key={share.id} value={share.id}>
                  {share.name}
                </option>
              ))}
            </select>
            {unconnectedCount > 0 ? (
              <p className={hintClass}>
                {unconnectedCount} more share{unconnectedCount === 1 ? '' : 's'} not shown — connect
                {unconnectedCount === 1 ? ' it' : ' them'} on the{' '}
                <Link href={`/${slug}/connectors`} className="text-blue-600 hover:underline dark:text-blue-400">
                  Connectors page
                </Link>
                .
              </p>
            ) : null}
          </>
        )}
      </div>

      <div>
        <span className={labelClass}>Folder</span>
        <div className="flex items-center gap-2">
          <p
            className={`${inputClass} truncate font-mono text-gray-600 dark:text-gray-400`}
            title={path}
          >
            {path}
          </p>
          <button
            type="button"
            disabled={!selectedShare}
            onClick={() => setPickerOpen(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.folder} className="h-4 w-4" />
            Browse…
          </button>
        </div>
        <p className={hintClass}>
          {selectedShare
            ? 'Where in the share to look. Defaults to the root.'
            : 'Choose a file share above to browse its folders.'}
        </p>
      </div>

      {pickerOpen && selectedShare ? (
        <FolderPicker
          tenantId={tenantId}
          shareId={selectedShare.id}
          shareName={selectedShare.name}
          initialPath={path}
          onCancel={() => setPickerOpen(false)}
          onSelect={(chosen) => {
            onPathChange(chosen);
            setPickerOpen(false);
          }}
        />
      ) : null}

      <div>
        <span className={labelClass}>How should documents be grouped?</span>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="strategy"
              checked={strategy === 'whole-file'}
              onChange={() => onStrategyChange('whole-file')}
              className="mt-1"
            />
            <span>
              <span className="font-medium">One file = one document</span>
              <span className="block text-gray-500 dark:text-gray-400">
                Each source file (a multi-page PDF or TIFF) is already a complete document.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="strategy"
              checked={strategy === 'filename-pattern'}
              onChange={() => onStrategyChange('filename-pattern')}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Group scanner pages by filename</span>
              <span className="block text-gray-500 dark:text-gray-400">
                The folder holds one file per page; correlate them back into documents by a
                pattern in the filename.
              </span>
            </span>
          </label>
        </div>
      </div>

      {strategy === 'filename-pattern' ? (
        <div>
          <label htmlFor="bj-pattern" className={labelClass}>
            Filename pattern
          </label>
          <input
            id="bj-pattern"
            value={pattern}
            onChange={(e) => onPatternChange(e.target.value)}
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            A regular expression with named captures <code>?&lt;documentKey&gt;</code> and{' '}
            <code>?&lt;page&gt;</code>. Pages sharing the same documentKey are assembled together,
            in page order.
          </p>
          {patternError ? (
            <p className="mt-1 text-xs text-red-700 dark:text-red-300">{patternError}</p>
          ) : (
            <p className="mt-1 text-xs text-green-700 dark:text-green-300">Pattern looks valid.</p>
          )}
        </div>
      ) : null}
    </>
  );
}
