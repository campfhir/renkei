'use client';

/**
 * Start a document-ocr-pipeline batch — the plain-form twin of the
 * batch_start_document_pipeline MCP tool, for someone who would rather
 * click through a form than ask an agent. POSTs to
 * /api/tenant/[tenantId]/batch-jobs, which shares startDocumentOcrPipeline
 * with the MCP tool.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getJson, sendJsonFull } from '@/lib/fetch-json';

interface ShareView {
  id: string;
  name: string;
  connection: { username: string } | null;
}

type Strategy = 'whole-file' | 'filename-pattern';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/** A regex must compile AND carry both named captures document-ocr-pipeline requires. */
function validatePattern(pattern: string): string | null {
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

export default function NewBatchJobForm({
  slug,
  tenantId,
}: {
  slug: string;
  tenantId: string;
}) {
  const router = useRouter();
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareId, setShareId] = useState('');
  const [path, setPath] = useState('/');
  const [strategy, setStrategy] = useState<Strategy>('whole-file');
  const [pattern, setPattern] = useState(String.raw`^(?<documentKey>.+)-p(?<page>\d+)\.tif$`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const unconnectedCount = (shares ?? []).length - connectedShares.length;
  const patternError = strategy === 'filename-pattern' ? validatePattern(pattern) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!shareId) {
      setError('Choose a file share.');
      return;
    }
    if (patternError) {
      setError(patternError);
      return;
    }
    setBusy(true);
    setError(null);
    const grouping =
      strategy === 'whole-file'
        ? { strategy: 'whole-file' as const }
        : { strategy: 'filename-pattern' as const, pattern };
    const { data, error: submitError } = await sendJsonFull<{ batchId: string }>(
      `/api/tenant/${tenantId}/batch-jobs`,
      'POST',
      { shareId, path: path.trim() || '/', grouping }
    );
    setBusy(false);
    if (submitError || !data) {
      setError(submitError ?? 'Could not start the batch job.');
      return;
    }
    router.push(`/${slug}/batch-jobs/${data.batchId}`);
  }

  if (loadError) {
    return <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>;
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
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
              onChange={(e) => setShareId(e.target.value)}
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
        <label htmlFor="bj-path" className={labelClass}>
          Folder path
        </label>
        <input
          id="bj-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/"
          className={`${inputClass} font-mono`}
        />
        <p className={hintClass}>Where in the share to look, from its root. Defaults to /.</p>
      </div>

      <div>
        <span className={labelClass}>How should documents be grouped?</span>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="strategy"
              checked={strategy === 'whole-file'}
              onChange={() => setStrategy('whole-file')}
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
              onChange={() => setStrategy('filename-pattern')}
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
            onChange={(e) => setPattern(e.target.value)}
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

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || shares === null || connectedShares.length === 0}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start batch job'}
        </button>
        {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </form>
  );
}
