import type { CrawlPage } from './types';

/**
 * Salesforce and Jira administration. A change request is proposed by a
 * chat, an agent or an MCP client against a connected org — a vendor's
 * OAuth — and space templates need Jira Administration connected: the
 * queues show their empty states, the templates page its "not connected"
 * gate, and a request's own page is not crawled.
 */
export const adminChangesPages: CrawlPage[] = [
  { path: '/salesforce-admin/changes', expectText: /^Nothing to review\./ },
  { path: '/jira-admin/changes', expectText: /^Nothing to review\./ },
  { path: '/jira-admin/templates', expectText: 'Jira Administration is not connected.' },
];
