/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_bulk_get_worklogs: one search/jql call covers a whole selection (the
 * 50-issue sprint that used to cost 50 jira_list_worklogs calls), the org's
 * maxJqlResults cap is respected (the old bulk tools hardcoded 100), and
 * per-issue overflow (>20 embedded worklogs) points at jira_list_worklogs.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (text: string) => text,
}));

import { registerWorklogTools } from './worklogs';
import type { JiraAuth } from './jira-auth';

const apiBaseUrl = 'https://api.atlassian.com/ex/jira/cloud-1';

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: (_requiredScopes, path, init) => jiraFetchMock(`${apiBaseUrl}${path}`, init),
  } as JiraAuth;
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];

function issueWith(key: string, worklogTotal: number): Record<string, unknown> {
  const shown = Math.min(worklogTotal, 20);
  return {
    key,
    fields: {
      summary: `Summary of ${key}`,
      timetracking: worklogTotal > 0 ? { timeSpent: `${worklogTotal}h` } : {},
      worklog: {
        total: worklogTotal,
        maxResults: 20,
        worklogs: Array.from({ length: shown }, (_unused, index) => ({
          id: `${key}-w${index}`,
          author: { displayName: 'Alice' },
          timeSpent: '1h',
          started: '2026-08-18T10:00:00.000+0000',
        })),
      },
    },
  };
}

function serve(issues: Record<string, unknown>[]): void {
  calls = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(
    async (url: string, request?: { method?: string; body?: string }) => {
      calls.push({
        url,
        method: request?.method ?? 'GET',
        body: request?.body ? JSON.parse(request.body) : null,
      });
      return { ok: true, status: 200, json: async () => ({ issues }) };
    }
  );
}

async function bulkWorklogs(maxJqlResults = 100): Promise<ToolHandler> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;

  await registerWorklogTools(
    server,
    {
      tenantId: 'tenant-1',
      accountId: 'acct-1',
      siteUrl: 'https://example.atlassian.net',
      apiBaseUrl,
      accessToken: 'token-1',
      maxJqlResults,
    } as MCPToolContext,
    stubAuth()
  );

  return registered.get('jira_bulk_get_worklogs')!;
}

const textOf = (result: ToolResult): string => result.content[0]?.text ?? '';

describe('jira_bulk_get_worklogs', () => {
  it('covers a whole JQL selection in ONE search call, worklog fields included', async () => {
    serve(Array.from({ length: 50 }, (_unused, index) => issueWith(`PROJ-${index + 1}`, 2)));
    const result = await (await bulkWorklogs())({ jql: 'sprint = 42' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/api/3/search/jql');
    expect(calls[0].body?.jql).toBe('sprint = 42');
    expect(calls[0].body?.fields).toEqual(['summary', 'worklog', 'timetracking']);
    expect(textOf(result)).toContain('across 50 issues');
    expect(textOf(result)).toContain('PROJ-1: Summary of PROJ-1 — total logged: 2h');
  });

  it('turns issueKeys into a key-in JQL', async () => {
    serve([issueWith('PROJ-7', 1)]);
    await (await bulkWorklogs())({ issueKeys: ['PROJ-7', 'PROJ-8'] });
    expect(calls[0].body?.jql).toBe('key in (PROJ-7, PROJ-8)');
  });

  it("respects the org's maxJqlResults cap", async () => {
    serve([]);
    await (await bulkWorklogs(25))({ jql: 'project = PROJ', maxResults: 100 });
    expect(calls[0].body?.maxResults).toBe(25);
  });

  it('points at jira_list_worklogs when an issue has more worklogs than one page embeds', async () => {
    serve([issueWith('PROJ-9', 35)]);
    const result = await (await bulkWorklogs())({ jql: 'key = PROJ-9' });
    expect(textOf(result)).toContain('… 15 more — call jira_list_worklogs PROJ-9');
  });

  it('requires a selection', async () => {
    serve([]);
    const result = await (await bulkWorklogs())({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('jql or issueKeys');
  });
});
