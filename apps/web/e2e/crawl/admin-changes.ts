import type { CrawlPage } from './types';

/**
 * Salesforce and Jira administration. A change request is proposed by a
 * chat, an agent or an MCP client against a connected org, and the queues
 * are the organization's: other specs fill them, so a queue is checked by
 * its heading, not by an empty state. Space templates need Jira
 * Administration connected, so that page shows its "not connected" gate;
 * a request's own page is not crawled.
 */
export const adminChangesPages: CrawlPage[] = [
  { path: '/salesforce-admin/changes', expectText: /^Salesforce admin changes$/ },
  { path: '/jira-admin/changes', expectText: /^Jira admin changes$/ },
  { path: '/jira-admin/templates', expectText: 'Jira Administration is not connected.' },
];
