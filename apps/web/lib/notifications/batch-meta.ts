/**
 * The batch-job side of a notification row, read back.
 *
 * The worker writes `agent_notifications.meta` for the three batch kinds
 * (apps/worker/src/batch-jobs/lifecycle.ts, `BatchNotificationMeta`); this
 * is the parser the feed, the toasts and the notifications page share, so
 * a row from an older or newer worker degrades to "just the headline"
 * rather than a crash — jsonb hands back whatever was stored, and a shape
 * written by the next deploy must not break the page reading it today.
 *
 * Pure and client-safe: no database, no Node imports.
 */

/** The row kinds the batch-jobs worker writes. */
export const BATCH_NOTIFICATION_KINDS = [
  'batch_started',
  'batch_finished',
  'batch_failed',
] as const;

export function isBatchNotificationKind(kind: string): boolean {
  return BATCH_NOTIFICATION_KINDS.some((known) => known === kind);
}

export interface BatchNotificationMeta {
  batchId: string;
  kind: string;
  /** 'Document OCR pipeline' — what the row shows; `kind` is the handler name. */
  kindLabel: string;
  name: string;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  skipped: number;
  error: string | null;
  scheduleId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;
const int = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;

/**
 * Null unless the meta names a batch — the one field nothing can be shown
 * without, since it is what the row links to. Everything else defaults.
 */
export function parseBatchNotificationMeta(raw: unknown): BatchNotificationMeta | null {
  if (!isRecord(raw)) return null;
  const batchId = str(raw.batchId);
  if (!batchId) return null;
  const kind = str(raw.kind);
  return {
    batchId,
    kind,
    kindLabel: str(raw.kindLabel) || kind,
    name: str(raw.name),
    status: str(raw.status),
    total:
      typeof raw.total === 'number' && Number.isFinite(raw.total) ? Math.trunc(raw.total) : null,
    succeeded: int(raw.succeeded),
    failed: int(raw.failed),
    skipped: int(raw.skipped),
    error: strOrNull(raw.error),
    scheduleId: strOrNull(raw.scheduleId),
    startedAt: strOrNull(raw.startedAt),
    finishedAt: strOrNull(raw.finishedAt),
  };
}

/** Where a batch notification opens — the batch's own page, in-app. */
export function batchNotificationHref(slug: string, meta: BatchNotificationMeta): string {
  return `/${slug}/batch-jobs/${meta.batchId}`;
}

/**
 * The "12/40 (11 ok, 1 failed)" fragment the batch pages use, for the
 * row's second line. Empty before totals are known (a started row).
 */
export function batchNotificationProgress(meta: BatchNotificationMeta): string {
  if (meta.total === null) return '';
  if (meta.total === 0) return 'nothing to process';
  const done = meta.succeeded + meta.failed + meta.skipped;
  const skipped = meta.skipped > 0 ? `, ${meta.skipped} skipped` : '';
  return `${done}/${meta.total} (${meta.succeeded} ok, ${meta.failed} failed${skipped})`;
}

/**
 * The line under a headline naming what the notification came from — an
 * agent's name for a run or an act, the kind of job for a batch. Shared by
 * the toast and the page so the two never disagree on it.
 */
export function notificationSourceLabel(row: {
  kind: string;
  agentName: string | null;
  meta?: unknown;
}): string {
  if (isBatchNotificationKind(row.kind)) {
    const meta = parseBatchNotificationMeta(row.meta);
    return meta ? `Batch job · ${meta.kindLabel}` : 'Batch job';
  }
  return row.agentName ?? 'An agent';
}
