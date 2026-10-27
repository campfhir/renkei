import type { CrawlPage } from './types';

/**
 * Batch jobs and their schedules run over a file share the person has
 * connected, and connecting one reaches the share's server: the lists show
 * their empty states, and a job's or a schedule's own page is not crawled.
 */
export const batchJobsPages: CrawlPage[] = [
  { path: '/batch-jobs', expectText: 'Long-running work over many documents at once' },
  { path: '/batch-jobs/new', expectText: 'New batch job' },
  { path: '/batch-jobs/schedules', expectText: 'No schedules yet.' },
  { path: '/batch-jobs/schedules/new', expectText: 'New schedule' },
];
