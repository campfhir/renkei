import type { TableRows } from '@renkei/db';
import type { CrawlPage } from './types';
import { crawlId } from './types';

const BATCH = crawlId(501);
const SCHEDULE = crawlId(511);

const batch = (subject: string): TableRows => ({
  batch_jobs: [
    {
      id: BATCH,
      subject,
      name: 'Crawl batch job',
      kind: 'document-ocr-pipeline',
      config: JSON.stringify({ shareId: 'share-1', path: '/inbox' }),
      status: 'running',
      total: 2,
      succeeded: 1,
    },
  ],
  batch_job_items: [
    {
      id: crawlId(502),
      batch_id: BATCH,
      status: 'succeeded',
      payload: JSON.stringify({ documentKey: 'crawl-invoice-0001' }),
      result: JSON.stringify({ sandboxFileId: 'crawl-file-1' }),
    },
    {
      id: crawlId(503),
      batch_id: BATCH,
      payload: JSON.stringify({ documentKey: 'crawl-invoice-0002' }),
    },
  ],
});

const schedule = (subject: string): TableRows => ({
  batch_job_schedules: [
    {
      id: SCHEDULE,
      subject,
      name: 'Crawl nightly schedule',
      kind: 'document-ocr-pipeline',
      config: JSON.stringify({
        shareId: 'share-1',
        path: '/inbox',
        grouping: { strategy: 'whole-file' },
      }),
      schedule_config: JSON.stringify({
        recurrences: [{ every: 'day', at: '02:00' }],
        timezone: 'UTC',
      }),
      next_run_at: new Date(Date.UTC(2030, 0, 1)),
    },
  ],
});

/** Pages of this area the memory crawl visits; see ./types.ts. */
export const batchJobsPages: CrawlPage[] = [
  { path: '/batch-jobs', seed: batch, expectText: 'Crawl batch job' },
  { path: `/batch-jobs/${BATCH}`, seed: batch, expectText: 'crawl-invoice-0002' },
  { path: '/batch-jobs/new', expectText: 'New batch job' },
  { path: '/batch-jobs/schedules', seed: schedule, expectText: 'Crawl nightly schedule' },
  { path: '/batch-jobs/schedules/new', expectText: 'New schedule' },
  {
    path: `/batch-jobs/schedules/${SCHEDULE}`,
    seed: schedule,
    expectText: 'Crawl nightly schedule',
  },
];
