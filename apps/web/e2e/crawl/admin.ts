import { addStubModel, removeModel } from '../support/stub-model';
import { agentOf, field, remove, send, type CrawlPage } from './types';

/**
 * The console's pages. Models and holiday calendars are organization-wide:
 * each is staged under the test's own tag through the console's own route
 * and deleted through it again afterwards. Provider grants, content
 * watches and webhook events come from vendors, and the identity provider
 * is the deployment's own: those pages show their empty states or their
 * plain form.
 */
export const adminPages: CrawlPage[] = [
  { path: '/admin', expectText: 'Organization' },
  { path: '/admin/access', expectText: /^Who is connected to what/ },
  {
    // Saving an agent is an audited change.
    path: '/admin/audit',
    stage: async ({ api, tag }) => {
      await agentOf(api, `Crawl audit agent ${tag}`);
    },
    expectText: /Crawl audit agent crawl-/,
  },
  {
    path: '/admin/events',
    expectText: 'Nothing yet — events appear as connected providers deliver webhooks.',
  },
  { path: '/admin/sites', expectText: /^None yet — they appear when someone connects/ },
  { path: '/admin/settings', expectText: 'Organization name' },
  { path: '/admin/storage', expectText: 'Storage' },
  { path: '/admin/usage', expectText: 'Organization usage' },
  { path: '/admin/grants', expectText: 'Access' },
  { path: '/admin/redaction', expectText: 'Sensitive data' },
  {
    path: '/admin/llm-models',
    stage: async ({ api, tag, cleanup }) => {
      const id = await addStubModel(api, tag);
      cleanup(() => removeModel(api, id));
    },
    expectText: /^Stub model crawl-/,
  },
  { path: '/admin/code-services', expectText: 'Code services' },
  { path: '/admin/pipeline-templates' },
  { path: '/admin/project-templates' },
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
