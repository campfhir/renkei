'use client';

/**
 * Start a document-ocr-pipeline batch — the plain-form twin of the
 * batch_start_document_pipeline MCP tool, for someone who would rather
 * click through a form than ask an agent. POSTs to
 * /api/tenant/[tenantId]/batch-jobs, which shares startDocumentOcrPipeline
 * with the MCP tool.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import SourceFields, {
  inputClass,
  labelClass,
  validateGroupingPattern,
  type GroupingStrategy,
} from '../source-fields';
import {
  KEEP_AFTER_PROCESSING,
  afterProcessingPayload,
  type AfterProcessingValue,
} from '@/lib/batch-jobs/pipeline-form-value';

export default function NewBatchJobForm({ slug, tenantId }: { slug: string; tenantId: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [shareId, setShareId] = useState('');
  const [path, setPath] = useState('/');
  const [strategy, setStrategy] = useState<GroupingStrategy>('whole-file');
  const [pattern, setPattern] = useState(String.raw`^(?<documentKey>.+)-p(?<page>\d+)\.tif$`);
  const [skipProcessed, setSkipProcessed] = useState(true);
  const [afterProcessing, setAfterProcessing] =
    useState<AfterProcessingValue>(KEEP_AFTER_PROCESSING);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patternError = strategy === 'filename-pattern' ? validateGroupingPattern(pattern) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give this batch a name.');
      return;
    }
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
      {
        name: name.trim(),
        shareId,
        path: path.trim() || '/',
        grouping,
        skipProcessed,
        afterProcessing: afterProcessingPayload(afterProcessing, shareId),
      }
    );
    setBusy(false);
    if (submitError || !data) {
      setError(submitError ?? 'Could not start the batch job.');
      return;
    }
    router.push(`/${slug}/batch-jobs/${data.batchId}`);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <div>
        <label htmlFor="bj-name" className={labelClass}>
          Name
        </label>
        <input
          id="bj-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Invoices — March 2026"
          className={inputClass}
        />
      </div>

      <SourceFields
        slug={slug}
        tenantId={tenantId}
        shareId={shareId}
        path={path}
        strategy={strategy}
        pattern={pattern}
        skipProcessed={skipProcessed}
        afterProcessing={afterProcessing}
        onShareIdChange={setShareId}
        onPathChange={setPath}
        onStrategyChange={setStrategy}
        onPatternChange={setPattern}
        onSkipProcessedChange={setSkipProcessed}
        onAfterProcessingChange={setAfterProcessing}
        onReadyChange={setReady}
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !ready}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start batch job'}
        </button>
        {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </form>
  );
}
