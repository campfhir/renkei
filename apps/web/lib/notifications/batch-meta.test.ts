/**
 * Reading a batch notification's meta back — including from rows a
 * different deploy wrote: the parser must degrade to "just the headline"
 * on anything it cannot use, never throw in the middle of the feed.
 */

import {
  batchNotificationHref,
  batchNotificationProgress,
  isBatchNotificationKind,
  notificationSourceLabel,
  parseBatchNotificationMeta,
} from './batch-meta';

const meta = {
  batchId: 'batch-1',
  kind: 'document-ocr-pipeline',
  kindLabel: 'Document OCR pipeline',
  name: 'Nightly scans',
  status: 'partial',
  total: 42,
  succeeded: 40,
  failed: 2,
  skipped: 0,
  error: null,
  scheduleId: 'sched-1',
  startedAt: '2026-09-01T02:00:00.000Z',
  finishedAt: '2026-09-01T03:00:00.000Z',
};

describe('isBatchNotificationKind', () => {
  it('knows the three batch kinds and nothing else', () => {
    expect(isBatchNotificationKind('batch_started')).toBe(true);
    expect(isBatchNotificationKind('batch_finished')).toBe(true);
    expect(isBatchNotificationKind('batch_failed')).toBe(true);
    expect(isBatchNotificationKind('run_finished')).toBe(false);
    expect(isBatchNotificationKind('act')).toBe(false);
  });
});

describe('parseBatchNotificationMeta', () => {
  it('round-trips what the worker writes', () => {
    expect(parseBatchNotificationMeta(meta)).toEqual(meta);
  });

  it('refuses anything without a batch id — there is nothing to link to', () => {
    expect(parseBatchNotificationMeta(null)).toBeNull();
    expect(parseBatchNotificationMeta('batch-1')).toBeNull();
    expect(parseBatchNotificationMeta({ ...meta, batchId: '' })).toBeNull();
  });

  it('defaults the rest rather than failing on a partial shape', () => {
    const parsed = parseBatchNotificationMeta({ batchId: 'batch-1', kind: 'future-kind' });
    expect(parsed).toEqual({
      batchId: 'batch-1',
      kind: 'future-kind',
      kindLabel: 'future-kind',
      name: '',
      status: '',
      total: null,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      error: null,
      scheduleId: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('ignores counts that are not numbers', () => {
    const parsed = parseBatchNotificationMeta({ ...meta, total: '42', succeeded: 'many' });
    expect(parsed?.total).toBeNull();
    expect(parsed?.succeeded).toBe(0);
  });
});

describe('rendering helpers', () => {
  it('links to the batch page in-app', () => {
    expect(batchNotificationHref('acme', parseBatchNotificationMeta(meta)!)).toBe(
      '/acme/batch-jobs/batch-1'
    );
  });

  it('words progress the way the batch pages do', () => {
    expect(batchNotificationProgress(parseBatchNotificationMeta(meta)!)).toBe(
      '42/42 (40 ok, 2 failed)'
    );
    expect(batchNotificationProgress(parseBatchNotificationMeta({ ...meta, total: null })!)).toBe(
      ''
    );
    expect(
      batchNotificationProgress(
        parseBatchNotificationMeta({ ...meta, total: 0, succeeded: 0, failed: 0 })!
      )
    ).toBe('nothing to process');
  });

  it('names the source as the kind of job for a batch, and the agent otherwise', () => {
    expect(notificationSourceLabel({ kind: 'batch_finished', agentName: null, meta })).toBe(
      'Batch job · Document OCR pipeline'
    );
    expect(notificationSourceLabel({ kind: 'batch_failed', agentName: null, meta: null })).toBe(
      'Batch job'
    );
    expect(notificationSourceLabel({ kind: 'run_finished', agentName: 'Sweeper' })).toBe('Sweeper');
    expect(notificationSourceLabel({ kind: 'act', agentName: null })).toBe('An agent');
  });
});
