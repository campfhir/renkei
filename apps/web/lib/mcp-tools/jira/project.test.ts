/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

// `../common` reaches the Kysely client, which is ESM and cannot be required
// here. Faking it also puts the request URL directly in reach, which is half of
// what these tests are checking.
const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  cacheUserDisplayName: () => undefined,
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (body: string, suggestion: string) =>
    `${body}\n\n(Presentation hint: ${suggestion})`,
}));

import { registerProjectTools } from './project';
import type { JiraAuth } from './jira-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const apiBaseUrl = 'https://api.atlassian.com/ex/jira/cloud-1';

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: (_requiredScopes, path, init) => jiraFetchMock(`${apiBaseUrl}${path}`, init),
  };
}

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
    apiBaseUrl,
    accessToken: 'token-1',
    maxJqlResults: 100,
  } as MCPToolContext;

  await registerProjectTools(server, context, stubAuth());
  return tools;
}

let requestedUrls: string[] = [];

const amanda = {
  displayName: 'Amanda Wong',
  emailAddress: 'amanda@nems.org',
  accountId: '557058:amanda',
};
const dana = { displayName: 'Dana Lin', emailAddress: 'dana@nems.org', accountId: '557058:dana' };

/** Answer each user search from `directory`, keyed by the `query` asked for. */
function respondFromDirectory(directory: Record<string, unknown[]>): void {
  requestedUrls = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(async (url: unknown) => {
    requestedUrls.push(String(url));
    const query = new URL(String(url)).searchParams.get('query') ?? '';
    return {
      ok: true,
      status: 200,
      json: async () => directory[query] ?? [],
    } as unknown as Response;
  });
}

describe('jira_search_users', () => {
  it('still takes a single name and renders the original flat list', async () => {
    respondFromDirectory({ 'amanda@nems.org': [amanda] });
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({ query: 'amanda@nems.org' });
    const text = result.content[0].text ?? '';

    expect(text).toContain('Found 1 users:');
    expect(text).toContain('• Amanda Wong (amanda@nems.org) - 557058:amanda');
    expect(requestedUrls).toHaveLength(1);
  });

  it('looks up every name in an array in one call, reporting each separately', async () => {
    respondFromDirectory({ 'amanda@nems.org': [amanda], 'Dana Lin': [dana] });
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({
      query: ['amanda@nems.org', 'Dana Lin'],
    });
    const text = result.content[0].text ?? '';

    expect(requestedUrls).toHaveLength(2);
    expect(text).toContain('Searched for 2 people, found 2 users:');
    expect(text).toContain('amanda@nems.org — 1 match:');
    expect(text).toContain('• Amanda Wong (amanda@nems.org) - 557058:amanda');
    expect(text).toContain('Dana Lin — 1 match:');
    expect(text).toContain('• Dana Lin (dana@nems.org) - 557058:dana');
    expect(result.isError).toBeUndefined();
  });

  it('says which of the batch found nobody rather than dropping them', async () => {
    respondFromDirectory({ 'amanda@nems.org': [amanda] });
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({
      query: ['amanda@nems.org', 'Nobody Here'],
    });
    const text = result.content[0].text ?? '';

    expect(text).toContain('Nobody Here — no match');
    expect(text).toContain('• Amanda Wong (amanda@nems.org) - 557058:amanda');
  });

  it('searches the same person named twice only once', async () => {
    respondFromDirectory({ 'amanda@nems.org': [amanda] });
    const tools = await registerTools();

    await tools.get('jira_search_users')!({
      query: ['amanda@nems.org', 'Amanda@NEMS.org', '  '],
    });

    expect(requestedUrls).toHaveLength(1);
  });

  it('keeps the matches it found when one name in the batch fails', async () => {
    requestedUrls = [];
    jiraFetchMock.mockReset();
    jiraFetchMock.mockImplementation(async (url: unknown) => {
      requestedUrls.push(String(url));
      const query = new URL(String(url)).searchParams.get('query') ?? '';
      if (query === 'Dana Lin') {
        return {
          ok: false,
          status: 429,
          json: async () => ({ message: 'rate limit exceeded' }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => [amanda] } as unknown as Response;
    });
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({
      query: ['amanda@nems.org', 'Dana Lin'],
    });
    const text = result.content[0].text ?? '';

    expect(text).toContain('• Amanda Wong (amanda@nems.org) - 557058:amanda');
    expect(text).toContain('Dana Lin — search failed:');
    // A partial answer is still worth reading, so the call is not an error.
    expect(result.isError).toBeUndefined();
  });

  it('contains a thrown network error to the one name it happened on', async () => {
    requestedUrls = [];
    jiraFetchMock.mockReset();
    jiraFetchMock.mockImplementation(async (url: unknown) => {
      requestedUrls.push(String(url));
      const query = new URL(String(url)).searchParams.get('query') ?? '';
      if (query === 'Dana Lin') throw new Error('socket hang up');
      return { ok: true, status: 200, json: async () => [amanda] } as unknown as Response;
    });
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({
      query: ['amanda@nems.org', 'Dana Lin'],
    });
    const text = result.content[0].text ?? '';

    expect(text).toContain('• Amanda Wong (amanda@nems.org) - 557058:amanda');
    expect(text).toContain('Dana Lin — search failed: socket hang up');
  });

  it('reports a batch where every name failed as an error', async () => {
    jiraFetchMock.mockReset();
    jiraFetchMock.mockImplementation(async () => {
      throw new Error('socket hang up');
    });
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({
      query: ['amanda@nems.org', 'Dana Lin'],
    });

    expect(result.isError).toBe(true);
  });

  it('refuses a batch larger than the cap instead of fanning out', async () => {
    respondFromDirectory({});
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({
      query: Array.from({ length: 26 }, (_, i) => `person-${i}`),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('too many names at once');
    expect(requestedUrls).toHaveLength(0);
  });

  it('rejects an empty query', async () => {
    respondFromDirectory({});
    const tools = await registerTools();

    const result = await tools.get('jira_search_users')!({ query: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query is required');
  });
});
