import type { TableRows } from '@renkei/db';
import type { CrawlPage } from './types';
import { crawlId } from './types';

/*
 * File shares, Mirth and ADManager Plus instances, MCP servers and connector
 * configs are organization-wide rows: they outlive the person a page's test
 * signs in, so every page below seeds its own, under its own ids and names
 * (the names are unique keys).
 */

function share(n: number, name: string) {
  return {
    id: crawlId(n),
    name,
    protocol: 'smb',
    host: `files${n}.crawl.test`,
    share_name: 'dept',
    case_insensitive: true,
  };
}

function instance(n: number, name: string) {
  return { id: crawlId(n), name, base_url: `https://server${n}.crawl.test:8443` };
}

function mcpServer(n: number, name: string) {
  return {
    id: crawlId(n),
    slug: `crawl-${n}`,
    name,
    url: `https://mcp${n}.crawl.test/mcp`,
    auth_mode: 'none',
  };
}

/** The connectors page: a share this person connected, so its card is on the page. */
function connectorsPageRows(subject: string): TableRows {
  return {
    file_shares: [share(101, 'Crawl connected share')],
    file_share_connections: [
      {
        share_id: crawlId(101),
        subject,
        encrypted_credentials: 'sealed',
        username: 'crawl-account',
        tool_access: 'read',
      },
    ],
    mcp_servers: [mcpServer(102, 'Crawl MCP on connectors')],
  };
}

/** Pages of this area the memory crawl visits; see ./types.ts. */
export const connectorsPages: CrawlPage[] = [
  {
    path: '/connectors',
    seed: connectorsPageRows,
    expectText: 'Crawl connected share',
  },
  {
    path: '/admin/connectors',
    seed: () => ({
      connector_configs: [
        { connector: 'mistral-ocr', enabled: false, encrypted_secrets: 'sealed', settings: '{}' },
      ],
    }),
    // Only a stored, switched-off config row puts this pill on the list.
    expectText: 'Disabled',
  },
  { path: '/admin/connectors/zoom' },
  {
    path: '/admin/file-shares',
    seed: () => ({ file_shares: [share(111, 'Crawl listed share')] }),
    expectText: 'Crawl listed share',
  },
  {
    path: `/admin/file-shares/${crawlId(112)}`,
    seed: () => ({ file_shares: [share(112, 'Crawl detail share')] }),
    expectText: 'Crawl detail share',
  },
  {
    path: '/admin/mirth',
    seed: () => ({ mirth_instances: [instance(121, 'Crawl listed Mirth')] }),
    expectText: 'Crawl listed Mirth',
  },
  {
    path: `/admin/mirth/${crawlId(122)}`,
    seed: () => ({ mirth_instances: [instance(122, 'Crawl detail Mirth')] }),
    expectText: 'Crawl detail Mirth',
  },
  {
    path: '/admin/admanager',
    seed: () => ({ admanager_instances: [instance(131, 'Crawl listed ADManager')] }),
    expectText: 'Crawl listed ADManager',
  },
  {
    path: `/admin/admanager/${crawlId(132)}`,
    seed: () => ({ admanager_instances: [instance(132, 'Crawl detail ADManager')] }),
    expectText: 'Crawl detail ADManager',
  },
  {
    path: '/admin/mcp',
    seed: () => ({ mcp_servers: [mcpServer(141, 'Crawl listed MCP')] }),
    expectText: 'Crawl listed MCP',
  },
  {
    path: '/admin/email-sanitizer',
    seed: () => ({
      email_classifier_rules: [
        {
          id: crawlId(151),
          category: 'marketing',
          match_type: 'domain',
          match_value: 'crawl-rule.test',
          priority: 1,
        },
      ],
    }),
    expectText: 'crawl-rule.test',
  },
  {
    path: '/mail-review',
    seed: (subject) => ({
      email_classification_log: [
        {
          id: crawlId(161),
          provider: 'microsoft',
          ref_id: `${subject}/msg/crawl`,
          // The crawl person's email is their subject (e2e/memory/fixtures.ts).
          owner_upn: subject.toLowerCase(),
          category: 'human',
          excerpt: 'Subject: Crawl excerpt',
        },
      ],
    }),
    expectText: 'Crawl excerpt',
  },
];
