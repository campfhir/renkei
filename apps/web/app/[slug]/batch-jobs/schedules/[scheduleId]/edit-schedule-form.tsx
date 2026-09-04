'use client';

/**
 * Edit a batch-job schedule's name, source/grouping, recurrence, or enabled
 * state, or delete it — the schedule twin of new-schedule-form.tsx, plus
 * the fields a fresh schedule has no history for yet.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJson } from '@/lib/fetch-json';
import type { ScheduleConfig } from '@renkei/agents';
import SourceFields, {
  inputClass,
  labelClass,
  validateGroupingPattern,
  type GroupingStrategy,
} from '../../source-fields';
import {
  afterProcessingPayload,
  type AfterProcessingValue,
} from '@/lib/batch-jobs/pipeline-form-value';
import { ScheduleEditor, type CalendarOption } from '../../../agents/builder/schedule-picker';

export interface SourceValue {
  shareId: string;
  path: string;
  strategy: GroupingStrategy;
  pattern: string;
  skipProcessed: boolean;
  afterProcessing: AfterProcessingValue;
}

export default function EditScheduleForm({
  slug,
  tenantId,
  scheduleId,
  initialName,
  initialSource,
  initialScheduleConfig,
  initialEnabled,
  lastError,
  calendars,
}: {
  slug: string;
  tenantId: string;
  scheduleId: string;
  initialName: string;
  initialSource: SourceValue;
  initialScheduleConfig: ScheduleConfig;
  initialEnabled: boolean;
  lastError: string | null;
  calendars: CalendarOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [shareId, setShareId] = useState(initialSource.shareId);
  const [path, setPath] = useState(initialSource.path);
  const [strategy, setStrategy] = useState<GroupingStrategy>(initialSource.strategy);
  const [pattern, setPattern] = useState(
    initialSource.pattern || String.raw`^(?<documentKey>.+)-p(?<page>\d+)\.tif$`
  );
  const [skipProcessed, setSkipProcessed] = useState(initialSource.skipProcessed);
  const [afterProcessing, setAfterProcessing] = useState<AfterProcessingValue>(
    initialSource.afterProcessing
  );
  const [ready, setReady] = useState(true); // an existing schedule already has a valid source
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfig>(initialScheduleConfig);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patternError = strategy === 'filename-pattern' ? validateGroupingPattern(pattern) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give this schedule a name.');
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
    const submitError = await sendJson(
      `/api/tenant/${tenantId}/batch-job-schedules/${scheduleId}`,
      'PUT',
      {
        name: name.trim(),
        shareId,
        path: path.trim() || '/',
        grouping,
        skipProcessed,
        afterProcessing: afterProcessingPayload(afterProcessing, shareId),
        scheduleConfig,
        enabled,
      }
    );
    setBusy(false);
    if (submitError) {
      setError(submitError);
      return;
    }
    router.push(`/${slug}/batch-jobs/schedules`);
    router.refresh();
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete the schedule "${name}"? This does not affect batches it already started.`
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    const deleteError = await sendJson(
      `/api/tenant/${tenantId}/batch-job-schedules/${scheduleId}`,
      'DELETE'
    );
    setDeleting(false);
    if (deleteError) {
      setError(deleteError);
      return;
    }
    router.push(`/${slug}/batch-jobs/schedules`);
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      {lastError ? (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span className="font-medium">Last error:</span> {lastError}
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      <div>
        <label htmlFor="bjs-name" className={labelClass}>
          Name
        </label>
        <input
          id="bjs-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
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

      <div>
        <span className={labelClass}>Recurrence</span>
        <ScheduleEditor value={scheduleConfig} onChange={setScheduleConfig} calendars={calendars} />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || deleting || !ready}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          disabled={busy || deleting}
          onClick={() => void remove()}
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
        >
          {deleting ? 'Deleting…' : 'Delete schedule'}
        </button>
        {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </form>
  );
}
