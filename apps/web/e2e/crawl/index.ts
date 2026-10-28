/** Every page the memory crawl visits, by area (one file per area, so areas move independently). */

import { adminChangesPages } from './admin-changes';
import { adminPages } from './admin';
import { agentsPages } from './agents';
import { batchJobsPages } from './batch-jobs';
import { chatCodePages } from './chat-code';
import { connectorsPages } from './connectors';
import { generalPages } from './general';
import type { CrawlPage } from './types';

export const CRAWL_PAGES: CrawlPage[] = [
  ...generalPages,
  ...chatCodePages,
  ...agentsPages,
  ...batchJobsPages,
  ...adminPages,
  ...connectorsPages,
  ...adminChangesPages,
];
