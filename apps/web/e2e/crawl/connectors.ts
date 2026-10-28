import { field, remove, send, type CrawlPage, type CrawlStage } from './types';

/*
 * File shares, Mirth and ADManager Plus instances, MCP servers and email
 * classifier rules are organization-wide: every page below registers its
 * own through the console's route, under the test's tag (names are
 * unique), and deletes it through the same route afterwards. Connecting
 * a share or an instance reaches its server, and mail is classified as it
 * is indexed, so the person's own connectors page and the mail review
 * show their plain and empty states.
 */

async function share({ api, tag, cleanup }: CrawlStage, name: string): Promise<string> {
  const id = field(
    await send(api, 'post', '/api/admin/file-shares', {
      name: `${name} ${tag}`,
      protocol: 'smb',
      host: 'files.crawl.test',
      shareName: 'dept',
    }),
    'id'
  );
  cleanup(() => remove(api, `/api/admin/file-shares/${id}`));
  return id;
}

async function instance(
  { api, tag, cleanup }: CrawlStage,
  kind: 'mirth' | 'admanager',
  name: string
): Promise<string> {
  const id = field(
    await send(api, 'post', `/api/admin/${kind}`, {
      name: `${name} ${tag}`,
      baseUrl: 'https://server.crawl.test:8443',
    }),
    'id'
  );
  cleanup(() => remove(api, `/api/admin/${kind}/${id}`));
  return id;
}

export const connectorsPages: CrawlPage[] = [
  { path: '/connectors', expectText: 'MCP endpoint' },
  { path: '/admin/connectors', expectText: 'Connector setup' },
  { path: '/admin/connectors/zoom' },
  {
    path: '/admin/file-shares',
    stage: async (stage) => {
      await share(stage, 'Crawl listed share');
    },
    expectText: /^Crawl listed share crawl-/,
  },
  {
    path: '/admin/file-shares/[shareId]',
    stage: async (stage) => `/admin/file-shares/${await share(stage, 'Crawl detail share')}`,
    expectText: /^Crawl detail share crawl-/,
  },
  {
    path: '/admin/mirth',
    stage: async (stage) => {
      await instance(stage, 'mirth', 'Crawl listed Mirth');
    },
    expectText: /^Crawl listed Mirth crawl-/,
  },
  {
    path: '/admin/mirth/[instanceId]',
    stage: async (stage) => `/admin/mirth/${await instance(stage, 'mirth', 'Crawl detail Mirth')}`,
    expectText: /^Crawl detail Mirth crawl-/,
  },
  {
    path: '/admin/admanager',
    stage: async (stage) => {
      await instance(stage, 'admanager', 'Crawl listed ADManager');
    },
    expectText: /^Crawl listed ADManager crawl-/,
  },
  {
    path: '/admin/admanager/[instanceId]',
    stage: async (stage) =>
      `/admin/admanager/${await instance(stage, 'admanager', 'Crawl detail ADManager')}`,
    expectText: /^Crawl detail ADManager crawl-/,
  },
  {
    path: '/admin/mcp',
    stage: async ({ api, tag, cleanup }) => {
      const created = await send(api, 'post', '/api/admin/mcp-servers', {
        name: `Crawl listed MCP ${tag}`,
        url: `https://mcp-${tag}.crawl.test/mcp`,
        authMode: 'none',
      });
      const server = created.server;
      const id = typeof server === 'object' && server !== null && 'id' in server ? server.id : null;
      if (typeof id !== 'string') throw new Error(`no server id in ${JSON.stringify(created)}`);
      cleanup(() => remove(api, `/api/admin/mcp-servers/${id}`));
    },
    expectText: /^Crawl listed MCP crawl-/,
  },
  {
    path: '/admin/email-sanitizer',
    stage: async ({ api, tag, cleanup }) => {
      const id = field(
        await send(api, 'post', '/api/admin/email-sanitizer/rules', {
          category: 'marketing',
          matchType: 'domain',
          matchValue: `${tag}.crawl-rule.test`,
          priority: 1,
        }),
        'id'
      );
      cleanup(() => remove(api, `/api/admin/email-sanitizer/rules/${id}`));
    },
    expectText: /crawl-[0-9a-f]+\.crawl-rule\.test/,
  },
  { path: '/mail-review', expectText: 'Human correspondence (0)' },
];
