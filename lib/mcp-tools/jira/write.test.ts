/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  jiraFetch: (...args: unknown[]) => jiraFetchMock(...args),
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  getCachedDisplayName: () => 'Tester',
}));

import { clearFieldSchemaCache } from './field-schema';
import { registerWriteTools } from './write';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];

const STORY_POINTS = {
  id: 'customfield_10016',
  name: 'Story Points',
  custom: true,
  schema: { type: 'number' },
  clauseNames: ['cf[10016]', 'Story Points'],
};

const DECISION = {
  id: 'customfield_12013',
  name: 'Decision of Change Request',
  custom: true,
  schema: { type: 'option' },
  clauseNames: ['cf[12013]'],
};

/** Serve the field endpoint from `schema`; accept anything else. */
function serve(schema: unknown[]): void {
  calls = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(
    async (url: string, _token: string, options?: { method?: string; body?: string }) => {
      calls.push({
        url,
        method: options?.method ?? 'GET',
        body: options?.body ? JSON.parse(options.body) : null,
      });
      const payload = url.endsWith('/field') ? schema : { key: 'CHG-20' };
      return { ok: true, status: 200, json: async () => payload };
    }
  );
}

async function updateIssue(): Promise<ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;

  await registerWriteTools(server, {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    siteUrl: 'https://example.atlassian.net',
    apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    accessToken: 'token-1',
    maxJqlResults: 100,
  } as MCPToolContext);

  return tools.get('update_issue')!;
}

const putBody = () => calls.find((call) => call.method === 'PUT')?.body ?? null;
const putFields = () => {
  const body = putBody();
  return body && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : null;
};

beforeEach(() => {
  clearFieldSchemaCache();
});

describe('update_issue', () => {
  it('still updates the plain fields without touching the schema', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', summary: 'New title' });

    expect(result.isError).toBeUndefined();
    expect(putFields()).toEqual({ summary: 'New title' });
    // No field lookup is needed for fields whose ids are fixed.
    expect(calls.some((call) => call.url.endsWith('/field'))).toBe(false);
  });

  it('resolves story points to this site own field id', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', storyPoints: 5 });

    expect(putFields()).toEqual({ customfield_10016: 5 });
    expect(result.content[0].text).toContain('Story Points → 5');
  });

  it('refuses story points on a site that has no such field, without writing', async () => {
    serve([DECISION]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', storyPoints: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('list_fields');
    expect(putBody()).toBeNull();
  });

  it('sets the original estimate through timetracking', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    await update({ issueKey: 'CHG-20', originalEstimate: '3d' });

    expect(putFields()).toEqual({ timetracking: { originalEstimate: '3d' } });
  });

  it('rejects an estimate Jira would not parse, without writing', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', originalEstimate: '3 days' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Jira duration');
    expect(putBody()).toBeNull();
  });

  it('resolves arbitrary fields by name and shapes them', async () => {
    serve([STORY_POINTS, DECISION]);
    const update = await updateIssue();

    const result = await update({
      issueKey: 'CHG-20',
      fields: { 'Decision of Change Request': 'Approved', '10016': 8 },
    });

    expect(putFields()).toEqual({
      customfield_12013: { value: 'Approved' },
      customfield_10016: 8,
    });
    expect(result.content[0].text).toContain('Decision of Change Request (customfield_12013)');
  });

  it('writes nothing at all when one field name does not resolve', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({
      issueKey: 'CHG-20',
      summary: 'would have applied',
      fields: { Nonexistent: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nothing updated');
    // The point of the all-or-nothing rule: the summary is not left applied.
    expect(putBody()).toBeNull();
  });

  it('combines everything into one request', async () => {
    serve([STORY_POINTS, DECISION]);
    const update = await updateIssue();

    await update({
      issueKey: 'CHG-20',
      summary: 'Billing change',
      storyPoints: 3,
      originalEstimate: '1w 2d',
      fields: { 'Decision of Change Request': 'Approved' },
    });

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(putFields()).toEqual({
      summary: 'Billing change',
      customfield_10016: 3,
      timetracking: { originalEstimate: '1w 2d' },
      customfield_12013: { value: 'Approved' },
    });
  });

  it('says so rather than sending an empty update', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nothing to update');
    expect(putBody()).toBeNull();
  });

  it('loads the schema once across several updates', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    await update({ issueKey: 'CHG-20', storyPoints: 1 });
    await update({ issueKey: 'CHG-21', storyPoints: 2 });
    await update({ issueKey: 'CHG-22', storyPoints: 3 });

    expect(calls.filter((call) => call.url.endsWith('/field'))).toHaveLength(1);
  });

  it('requires an issue key', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ storyPoints: 5 });

    expect(result.isError).toBe(true);
    expect(putBody()).toBeNull();
  });
});
