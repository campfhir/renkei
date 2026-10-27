import type { CrawlPage } from './types';
import { crawlId } from './types';

/** Pages of this area the memory crawl visits; see ./types.ts. */
export const generalPages: CrawlPage[] = [
  { path: '/about', expectText: 'What’s changed' },
  {
    path: '/notifications',
    seed: (subject) => ({
      agent_notifications: [
        { id: crawlId(1), subject, kind: 'agent_run', headline: 'Crawl notification' },
      ],
    }),
    expectText: 'Crawl notification',
  },
  { path: '/tutorials', expectText: 'Tutorials' },
  { path: '/admin/tutorials' },
];
