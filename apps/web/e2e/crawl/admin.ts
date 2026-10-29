import { field, remove, send, type CrawlPage } from './types';

/**
 * The console's pages. Models and holiday calendars are organization-wide:
 * each is staged under the test's own tag through the console's own route
 * and deleted through it again afterwards. Provider grants, content
 * watches and webhook events come from vendors, and the identity provider
 * is the deployment's own: those pages show their empty states or their
 * plain form.
 */
export const adminPages: CrawlPage[] = [
  // The organization's webhook events and Atlassian sites: other specs'
  // connections add to them, so each is checked by its heading.

  { path: '/admin/sites', expectText: /^Sites$/ },
  { path: '/admin/storage', expectText: 'Storage' },
  { path: '/admin/grants', expectText: 'Access' },
  { path: '/admin/redaction', expectText: 'Sensitive data' },
  {
    path: '/admin/calendars',
    stage: async ({ api, tag, cleanup }) => {
      const id = field(
        await send(api, 'post', '/api/admin/schedule-calendars', {
          name: `Crawl Calendar ${tag}`,
          dates: [],
        }),
        'id'
      );
      cleanup(() => remove(api, `/api/admin/schedule-calendars/${id}`));
    },
    expectText: /Crawl Calendar crawl-/,
  },
];
