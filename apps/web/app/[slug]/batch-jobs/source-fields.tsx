'use client';

/**
 * The share/folder/grouping fields document-ocr-pipeline needs — shared by
 * the one-off "new batch job" form and the "new/edit schedule" form so the
 * two cannot drift on what's asked for or how it's validated. Fully
 * controlled (value/onChange per field), the same shape as ScheduleEditor
 * in the agent builder — the caller owns the state, this just renders it.
 *
 * Two optional behaviours ride along: whether files an earlier batch
 * already processed are skipped (on by default — the deterministic ledger
 * in packages/batch-jobs-store), and what happens to a source file once
 * its document is staged (keep, move, delete — off by default). The
 * move/delete options are greyed out where the person has not enabled
 * write/delete tools for the share on the Connectors page; the server
 * refuses the same way, this just says so before the click.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getJson } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';
import type { AfterProcessingValue } from '@/lib/batch-jobs/pipeline-form-value';
import FolderPicker from './new/folder-picker';

export type GroupingStrategy = 'whole-file' | 'filename-pattern';

interface ShareView {
  id: string;
  name: string;
  connection: {
    username: string;
    toolAccess?: 'read' | 'read_write';
    allowDelete?: boolean;
  } | null;
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

/** Why a share cannot have its files moved/deleted by a batch, or null. */
function removalRefusal(share: ShareView | null): string | null {
  if (!share?.connection) return 'Choose a file share first.';
  if (share.connection.toolAccess !== 'read_write') {
    return `Needs write tools enabled for "${share.name}" on the Connectors page.`;
  }
  if (!share.connection.allowDelete) {
    return `Needs delete tools enabled for "${share.name}" on the Connectors page.`;
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
  skipProcessed,
  afterProcessing,
  onShareIdChange,
  onPathChange,
  onStrategyChange,
  onPatternChange,
  onSkipProcessedChange,
  onAfterProcessingChange,
  onReadyChange,
}: {
  slug: string;
  tenantId: string;
  shareId: string;
  path: string;
  strategy: GroupingStrategy;
  pattern: string;
  skipProcessed: boolean;
  afterProcessing: AfterProcessingValue;
  onShareIdChange: (shareId: string) => void;
  onPathChange: (path: string) => void;
  onStrategyChange: (strategy: GroupingStrategy) => void;
  onPatternChange: (pattern: string) => void;
  onSkipProcessedChange: (on: boolean) => void;
  onAfterProcessingChange: (value: AfterProcessingValue) => void;
  /** Fires whenever "is there at least one connected share to pick" changes. */
  onReadyChange?: (ready: boolean) => void;
}) {
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState<'source' | 'destination' | null>(null);

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
  const destinationShare =
    connectedShares.find((share) => share.id === (afterProcessing.shareId || shareId)) ??
    selectedShare;
  const removalBlocked = removalRefusal(selectedShare);
  const writableShares = connectedShares.filter(
    (share) => share.connection?.toolAccess === 'read_write'
  );

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
            <Link
              href={`/${slug}/connectors`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
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
                <Link
                  href={`/${slug}/connectors`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
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
            onClick={() => setPickerOpen('source')}
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

      {pickerOpen === 'source' && selectedShare ? (
        <FolderPicker
          tenantId={tenantId}
          shareId={selectedShare.id}
          shareName={selectedShare.name}
          initialPath={path}
          onCancel={() => setPickerOpen(null)}
          onSelect={(chosen) => {
            onPathChange(chosen);
            setPickerOpen(null);
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
                The folder holds one file per page; correlate them back into documents by a pattern
                in the filename.
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

      <div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={skipProcessed}
            onChange={(e) => onSkipProcessedChange(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Skip files that were already processed</span>
            <span className="block text-gray-500 dark:text-gray-400">
              A file whose contents an earlier batch on this share already OCR’d is skipped, by a
              hash of its bytes — so the same folder can be run again and again without paying for
              the same document twice. Turn off to process every file and keep no record.
            </span>
          </span>
        </label>
      </div>

      <div>
        <span className={labelClass}>After a document is processed</span>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="after-processing"
              checked={afterProcessing.action === 'keep'}
              onChange={() => onAfterProcessingChange({ ...afterProcessing, action: 'keep' })}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Leave the source files where they are</span>
            </span>
          </label>
          <label
            className={`flex items-start gap-2 text-sm ${removalBlocked ? 'opacity-60' : ''}`}
            title={removalBlocked ?? undefined}
          >
            <input
              type="radio"
              name="after-processing"
              disabled={removalBlocked !== null}
              checked={afterProcessing.action === 'move'}
              onChange={() => onAfterProcessingChange({ ...afterProcessing, action: 'move' })}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Move the source files to a folder</span>
              <span className="block text-gray-500 dark:text-gray-400">
                On this share or another one you have connected — a “processed” folder, say.
              </span>
            </span>
          </label>
          <label
            className={`flex items-start gap-2 text-sm ${removalBlocked ? 'opacity-60' : ''}`}
            title={removalBlocked ?? undefined}
          >
            <input
              type="radio"
              name="after-processing"
              disabled={removalBlocked !== null}
              checked={afterProcessing.action === 'delete'}
              onChange={() => onAfterProcessingChange({ ...afterProcessing, action: 'delete' })}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Delete the source files</span>
              <span className="block text-gray-500 dark:text-gray-400">
                Permanently — a file server has no recycle bin. The OCR text stays in your sandbox.
              </span>
            </span>
          </label>
        </div>
        {removalBlocked && selectedShare ? (
          <p className={hintClass}>
            {removalBlocked}{' '}
            <Link
              href={`/${slug}/connectors`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Open Connectors
            </Link>
          </p>
        ) : null}
      </div>

      {afterProcessing.action === 'move' ? (
        <div className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <div>
            <label htmlFor="bj-dest-share" className={labelClass}>
              Move to share
            </label>
            <select
              id="bj-dest-share"
              value={afterProcessing.shareId || shareId}
              onChange={(e) =>
                onAfterProcessingChange({ ...afterProcessing, shareId: e.target.value, path: '/' })
              }
              className={inputClass}
            >
              {writableShares.map((share) => (
                <option key={share.id} value={share.id}>
                  {share.name}
                  {share.id === shareId ? ' (same share)' : ''}
                </option>
              ))}
            </select>
            <p className={hintClass}>Only shares with write tools enabled are listed.</p>
          </div>
          <div>
            <span className={labelClass}>Destination folder</span>
            <div className="flex items-center gap-2">
              <p
                className={`${inputClass} truncate font-mono text-gray-600 dark:text-gray-400`}
                title={afterProcessing.path}
              >
                {afterProcessing.path}
              </p>
              <button
                type="button"
                disabled={!destinationShare}
                onClick={() => setPickerOpen('destination')}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.folder} className="h-4 w-4" />
                Browse…
              </button>
            </div>
            <p className={hintClass}>
              The folder must already exist. A file with the same name already there is never
              overwritten — that document fails instead, so nothing is lost silently.
            </p>
          </div>
        </div>
      ) : null}

      {pickerOpen === 'destination' && destinationShare ? (
        <FolderPicker
          tenantId={tenantId}
          shareId={destinationShare.id}
          shareName={destinationShare.name}
          initialPath={afterProcessing.path}
          onCancel={() => setPickerOpen(null)}
          onSelect={(chosen) => {
            onAfterProcessingChange({
              ...afterProcessing,
              shareId: destinationShare.id,
              path: chosen,
            });
            setPickerOpen(null);
          }}
        />
      ) : null}
    </>
  );
}
