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
import { clearFieldSchemaCache } from './field-schema';
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

describe('jira_list_components', () => {
  it('names the lead and what the component is for', async () => {
    // Both arrive in this response; the hint's own Lead column was empty.
    requestedUrls = [];
    jiraFetchMock.mockReset();
    jiraFetchMock.mockImplementation(async (url: unknown) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: '10010',
            name: 'Billing',
            description: 'Invoicing and payments',
            lead: { displayName: 'Amanda Wong' },
          },
          { id: '10011', name: 'Search' },
        ],
      } as unknown as Response;
    });
    const tools = await registerTools();

    const text =
      (await tools.get('jira_list_components')!({ projectKey: 'CAS' })).content[0].text ?? '';

    expect(text).toContain('• Billing (ID: 10010) — lead: Amanda Wong — Invoicing and payments');
    // A component with neither stays exactly as it was.
    expect(text).toContain('• Search (ID: 10011)');
  });
});

const fieldDirectory = [
  { name: 'Project Health', id: 'customfield_12180', schema: { type: 'option' } },
  { name: 'Risk Impact', id: 'customfield_12179', schema: { type: 'option' } },
  { name: 'Risk Likelihood', id: 'customfield_12177', schema: { type: 'option' } },
  { name: 'Risk Last Reviewed', id: 'customfield_12178', schema: { type: 'date' } },
  { name: 'Story Points', id: 'customfield_10024', schema: { type: 'number' } },
  { name: 'Summary', id: 'summary', schema: { type: 'string' } },
];

/** The option values createmeta reports for project CIO, by field id. */
const createmetaFields: Record<string, unknown> = {
  customfield_12180: {
    allowedValues: [
      { id: '15001', value: 'On track' },
      { id: '15002', value: 'At risk' },
    ],
  },
  customfield_12179: {
    allowedValues: [
      { id: '15010', value: 'High' },
      { id: '15011', value: 'Low' },
    ],
  },
};

/**
 * Answer the field directory, and createmeta with `options` (none by
 * default — a site this caller cannot read createmeta on, or a field that
 * is on no create screen).
 */
function respondWithFields(options: Record<string, unknown> | null = null): void {
  requestedUrls = [];
  jiraFetchMock.mockReset();
  // The option lookup caches per site and per project, and it would
  // otherwise carry values from the test before this one.
  clearFieldSchemaCache();
  jiraFetchMock.mockImplementation(async (url: unknown) => {
    requestedUrls.push(String(url));
    const body = String(url).includes('createmeta')
      ? { projects: [{ issuetypes: [{ name: 'Task', id: '10001', fields: options ?? {} }] }] }
      : fieldDirectory;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}

/** The requests that fetched the field directory, not the option lookup. */
const directoryFetches = () => requestedUrls.filter((url) => !url.includes('createmeta'));

describe('jira_list_fields', () => {
  it('still filters on a single string exactly as before', async () => {
    respondWithFields();
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({ projectKey: 'CIO', query: 'Risk' });
    const text = result.content[0].text ?? '';

    expect(text).toContain('3 of 6 fields match "Risk":');
    expect(text).toContain('• Risk Impact (customfield_12179) - option');
  });

  it('answers several filters from one fetch, reporting each separately', async () => {
    respondWithFields();
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({
      projectKey: 'CIO',
      query: ['Project Health', 'Risk', 'Story Points'],
    });
    const text = result.content[0].text ?? '';

    // The whole directory is fetched once and filtered here, so extra
    // filters must not cost extra round trips — that is the entire point.
    // The option lookup is likewise one call for the whole answer.
    expect(directoryFetches()).toHaveLength(1);
    expect(requestedUrls.filter((url) => url.includes('createmeta'))).toHaveLength(1);
    expect(text).toContain('6 fields on this site, matched against 3 filters:');
    expect(text).toContain('"Project Health" — 1 match:');
    expect(text).toContain('• Project Health (customfield_12180) - option');
    expect(text).toContain('"Risk" — 3 matches:');
    expect(text).toContain('"Story Points" — 1 match:');
    expect(text).toContain('• Story Points (customfield_10024) - number');
  });

  it('names a filter that matched nothing instead of omitting it', async () => {
    respondWithFields();
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({
      query: ['Risk', 'Target Number'],
    });

    expect(result.content[0].text).toContain('"Target Number" — no match');
  });

  it('lists everything when no filter is given', async () => {
    respondWithFields();
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({ projectKey: 'CIO' });

    expect(result.content[0].text).toContain('Found 6 fields:');
  });

  it('spells out what an option field accepts, so a write need not guess', async () => {
    // The whole point: an id alone leaves a caller inventing a value, and
    // Jira answers a wrong one with a 400 that names nothing.
    respondWithFields(createmetaFields);
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({
      projectKey: 'CIO',
      query: ['Project Health', 'Story Points'],
    });
    const text = result.content[0].text ?? '';

    expect(text).toContain('• Project Health (customfield_12180) - option');
    expect(text).toContain('options: "On track" (id 15001), "At risk" (id 15002)');
    // A number field has no closed set, so it gets no options line.
    expect(text).toContain('• Story Points (customfield_10024) - number');
    expect(text).not.toContain('options: pass projectKey');
  });

  it('asks for a projectKey rather than staying silent about options', async () => {
    respondWithFields(createmetaFields);
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({ query: 'Project Health' });
    const text = result.content[0].text ?? '';

    expect(text).toContain('options: pass projectKey to list them');
    // Nothing to look them up against, so nothing is looked up.
    expect(requestedUrls.some((url) => url.includes('createmeta'))).toBe(false);
  });

  it('says an option field reported no values instead of implying it takes any', async () => {
    respondWithFields();
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({
      projectKey: 'CIO',
      query: 'Project Health',
    });

    expect(result.content[0].text).toContain('options: none reported for CIO');
  });

  it('does not spend a round trip when nothing matched has options', async () => {
    respondWithFields(createmetaFields);
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({
      projectKey: 'CIO',
      query: 'Story Points',
    });

    expect(result.content[0].text).toContain('• Story Points (customfield_10024) - number');
    expect(requestedUrls.some((url) => url.includes('createmeta'))).toBe(false);
  });

  it('treats a repeated filter as one', async () => {
    respondWithFields();
    const tools = await registerTools();

    const result = await tools.get('jira_list_fields')!({ query: ['Risk', 'risk'] });

    // Down to one filter, so it renders as the single-filter case.
    expect(result.content[0].text).toContain('3 of 6 fields match "Risk":');
  });
});
