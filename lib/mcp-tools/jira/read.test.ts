/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

// `../common` reaches the Kysely client, which is ESM and cannot be required
// here. Faking it also puts the request URL directly in reach, which is half of
// what these tests are checking.
const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  jiraFetch: (...args: unknown[]) => jiraFetchMock(...args),
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  cacheUserDisplayName: () => undefined,
  getCachedDisplayName: () => 'Tester',
}));

import { registerReadTools } from './read';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Collect the handlers `registerReadTools` registers, so they can be called directly. */
async function registerTools(): Promise<Map<string, ToolHandler>> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;

  const context = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    siteUrl: 'https://example.atlassian.net',
    apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    accessToken: 'token-1',
    maxJqlResults: 100,
  } as MCPToolContext;

  await registerReadTools(server, context);
  return tools;
}

let requestedUrls: string[] = [];

/** Answer every request with `payload`, recording the URL that was asked for. */
function respondWith(payload: unknown): void {
  requestedUrls = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(async (url: unknown) => {
    requestedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  });
}

const adfDescription = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Migrate the billing schema.' }] },
  ],
};

const issue = {
  key: 'CHG-20',
  fields: {
    summary: 'Billing schema change',
    status: { name: 'In Review' },
    priority: { name: 'High' },
    issuetype: { name: 'Change Management' },
    assignee: { displayName: 'Dana Lin' },
    created: '2026-07-01T10:00:00.000Z',
    updated: '2026-07-02T11:00:00.000Z',
    description: adfDescription,
    customfield_12013: { value: 'Approved', id: '10201' },
    customfield_12014: { value: 'Infrastructure', child: { value: 'Network' } },
    customfield_12015: null,
  },
  names: {
    customfield_12013: 'Decision of Change Request',
    customfield_12014: 'Change Category',
    customfield_12015: 'Backout Plan',
  },
};

describe('get_issue', () => {
  it('renders an ADF description as text instead of [object Object]', async () => {
    respondWith(issue);
    const tools = await registerTools();

    const result = await tools.get('get_issue')!({ issueKey: 'CHG-20' });
    const text = result.content[0].text ?? '';

    expect(text).toContain('Description:\nMigrate the billing schema.');
    expect(text).not.toContain('[object Object]');
  });

  it('asks only for the default fields when none are requested', async () => {
    respondWith(issue);
    const tools = await registerTools();

    await tools.get('get_issue')!({ issueKey: 'CHG-20' });

    expect(requestedUrls[0]).toBe(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/CHG-20'
    );
  });

  it('requests named fields alongside the standard set, and expands their names', async () => {
    respondWith(issue);
    const tools = await registerTools();

    await tools.get('get_issue')!({ issueKey: 'CHG-20', fields: ['12013', 'cf[12014]'] });

    const url = new URL(requestedUrls[0]);
    const fields = (url.searchParams.get('fields') ?? '').split(',');
    expect(fields).toContain('summary');
    expect(fields).toContain('description');
    expect(fields).toContain('customfield_12013');
    expect(fields).toContain('customfield_12014');
    expect(url.searchParams.get('expand')).toBe('names');
  });

  it('prints requested custom fields as name, id and unwrapped value', async () => {
    respondWith(issue);
    const tools = await registerTools();

    const result = await tools.get('get_issue')!({
      issueKey: 'CHG-20',
      fields: ['customfield_12013', '12014'],
    });
    const text = result.content[0].text ?? '';

    expect(text).toContain('Decision of Change Request (customfield_12013): Approved');
    expect(text).toContain('Change Category (customfield_12014): Infrastructure → Network');
  });

  it('distinguishes an empty field from one the issue does not have', async () => {
    respondWith(issue);
    const tools = await registerTools();

    const result = await tools.get('get_issue')!({
      issueKey: 'CHG-20',
      fields: ['12015', 'customfield_99999'],
    });
    const text = result.content[0].text ?? '';

    expect(text).toContain('Backout Plan (customfield_12015): (empty)');
    expect(text).toContain('customfield_99999): not present on this issue');
  });

  it('lists every populated field for *all, leaving out the standard ones', async () => {
    respondWith(issue);
    const tools = await registerTools();

    const result = await tools.get('get_issue')!({ issueKey: 'CHG-20', fields: ['*all'] });
    const text = result.content[0].text ?? '';

    expect(requestedUrls[0]).toContain('fields=*all');
    expect(text).toContain('Decision of Change Request (customfield_12013): Approved');
    // Empty, and the standard fields already have their own lines above.
    expect(text).not.toContain('Backout Plan');
    expect(text).not.toMatch(/^summary \(/m);
  });

  it('still reports the standard metadata block', async () => {
    respondWith(issue);
    const tools = await registerTools();

    const result = await tools.get('get_issue')!({ issueKey: 'CHG-20' });
    const text = result.content[0].text ?? '';

    expect(text).toContain('CHG-20: Billing schema change');
    expect(text).toContain('Status: In Review');
    expect(text).toContain('Assignee: Dana Lin');
    expect(text).toContain('[Open in Jira](https://example.atlassian.net/browse/CHG-20)');
  });
});
