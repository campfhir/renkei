'use client';

/**
 * Define a recurring document-ocr-pipeline batch — the schedule twin of
 * new-batch-job-form.tsx: same source/grouping fields, plus the SAME
 * ScheduleEditor the agent builder uses for its own schedule triggers
 * (packages/agents' ScheduleConfig, computed next_run_at server-side on
 * save via /api/tenant/[tenantId]/batch-job-schedules).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import type { ScheduleConfig } from '@renkei/agents';
import SourceFields, {
  inputClass,
  labelClass,
  validateGroupingPattern,
  type GroupingStrategy,
} from '../../source-fields';
import { ScheduleEditor, type CalendarOption } from '../../../agents/builder/schedule-picker';

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export default function NewScheduleForm({
  slug,
  tenantId,
  calendars,
}: {
  slug: string;
  tenantId: string;
  calendars: CalendarOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [shareId, setShareId] = useState('');
  const [path, setPath] = useState('/');
  const [strategy, setStrategy] = useState<GroupingStrategy>('whole-file');
  const [pattern, setPattern] = useState(String.raw`^(?<documentKey>.+)-p(?<page>\d+)\.tif$`);
  const [ready, setReady] = useState(false);
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfig>({
    recurrences: [{ every: 'day', at: '09:00' }],
    timezone: defaultTimezone(),
  });
  const [busy, setBusy] = useState(false);
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
    const { data, error: submitError } = await sendJsonFull<{ id: string }>(
      `/api/tenant/${tenantId}/batch-job-schedules`,
      'POST',
      { name: name.trim(), shareId, path: path.trim() || '/', grouping, scheduleConfig }
    );
    setBusy(false);
    if (submitError || !data) {
      setError(submitError ?? 'Could not create the schedule.');
      return;
    }
    router.push(`/${slug}/batch-jobs/schedules/${data.id}`);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <div>
        <label htmlFor="bjs-name" className={labelClass}>
          Name
        </label>
        <input
          id="bjs-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Nightly invoice OCR"
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
        onShareIdChange={setShareId}
        onPathChange={setPath}
        onStrategyChange={setStrategy}
        onPatternChange={setPattern}
        onReadyChange={setReady}
      />

      <div>
        <span className={labelClass}>Recurrence</span>
        <ScheduleEditor value={scheduleConfig} onChange={setScheduleConfig} calendars={calendars} />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !ready}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create schedule'}
        </button>
        {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </form>
  );
}
