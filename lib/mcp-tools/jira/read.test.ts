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
  requestBodies = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(
    async (url: unknown, _token: unknown, request?: { body?: string }) => {
      requestedUrls.push(String(url));
      requestBodies.push(request?.body ? JSON.parse(request.body) : null);
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }
  );
}

let requestBodies: (Record<string, unknown> | null)[] = [];

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

describe('count_issues', () => {
  it('asks the count endpoint rather than paging results', async () => {
    respondWith({ count: 137 });
    const tools = await registerTools();

    const result = await tools.get('count_issues')!({
      jql: "assignee = 'celia.li@nems.org'",
    });

    expect(requestedUrls[0]).toBe(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/search/approximate-count'
    );
    expect(requestBodies[0]).toEqual({ jql: "assignee = 'celia.li@nems.org'" });
    expect(result.content[0].text).toContain('137 issues match');
  });

  it('says the number is an estimate, because Jira does not count exactly', async () => {
    respondWith({ count: 137 });
    const tools = await registerTools();

    const result = await tools.get('count_issues')!({ jql: 'project = CAS' });

    expect(result.content[0].text).toContain('approximate');
  });

  it('reads as a sentence for a single match', async () => {
    respondWith({ count: 1 });
    const tools = await registerTools();

    const result = await tools.get('count_issues')!({ jql: 'key = CAS-1' });

    expect(result.content[0].text).toContain('1 issue matches');
  });

  it('requires a query', async () => {
    respondWith({ count: 0 });
    const tools = await registerTools();

    const result = await tools.get('count_issues')!({ jql: '   ' });

    expect(result.isError).toBe(true);
    expect(requestedUrls).toHaveLength(0);
  });

  it('reports an unusable response rather than a number it did not get', async () => {
    respondWith({ errorMessages: ['bad jql'] });
    const tools = await registerTools();

    const result = await tools.get('count_issues')!({ jql: 'nonsense =' });

    expect(result.isError).toBe(true);
  });
});

describe('search_issues truncation', () => {
  it('points at count_issues when more issues match than were returned', async () => {
    respondWith({
      issues: [{ key: 'CAS-1', fields: { summary: 'One', status: { name: 'Open' } } }],
      nextPageToken: 'more-please',
    });
    const tools = await registerTools();

    const result = await tools.get('search_issues')!({ jql: 'project = CAS' });

    // The transcript this comes from: a capped list was read as "100+ tickets",
    // with no way to find the actual number.
    expect(result.content[0].text).toContain('count_issues');
  });

  it('says nothing about counting when the results are complete', async () => {
    respondWith({
      issues: [{ key: 'CAS-1', fields: { summary: 'One', status: { name: 'Open' } } }],
    });
    const tools = await registerTools();

    const result = await tools.get('search_issues')!({ jql: 'project = CAS' });

    expect(result.content[0].text).not.toContain('count_issues');
  });
});
