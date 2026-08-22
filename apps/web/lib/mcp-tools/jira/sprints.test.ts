/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  sprintUrl: (siteUrl: string, boardId: string) => `${siteUrl}/board/${boardId}`,
  getCachedDisplayName: () => 'Tester',
}));

import { clearFieldSchemaCache } from './field-schema';
import { registerSprintTools } from './sprints';
import type { JiraAuth } from './jira-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const apiBaseUrl = 'https://api.atlassian.com/ex/jira/cloud-1';

/** A stub JiraAuth reconstructing the full URL, so assertions can stay unchanged. */
function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: (_requiredScopes, path, init) => jiraFetchMock(`${apiBaseUrl}${path}`, init),
  };
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];

interface ServeOptions {
  /** The agile issue payload, or null to make that endpoint fail. */
  agileIssue?: Record<string, unknown> | null;
  boards?: { id: number; name: string }[];
}

function serve(options: ServeOptions = {}): void {
  calls = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(
    async (url: string, request?: { method?: string; body?: string }) => {
      calls.push({
        url,
        method: request?.method ?? 'GET',
        body: request?.body ? JSON.parse(request.body) : null,
      });

      if (url.includes('/rest/agile/1.0/issue/')) {
        if (options.agileIssue === null) throw new Error('Jira API 404: not found');
        return {
          ok: true,
          status: 200,
          json: async () => options.agileIssue ?? { fields: {} },
        };
      }

      if (url.includes('/rest/agile/1.0/board?')) {
        return { ok: true, status: 200, json: async () => ({ values: options.boards ?? [] }) };
      }

      return { ok: true, status: 204, json: async () => ({}) };
    }
  );
}

async function sprintTools(): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;

  await registerSprintTools(
    server,
    {
      tenantId: 'tenant-1',
      accountId: 'acct-1',
      siteUrl: 'https://example.atlassian.net',
      apiBaseUrl,
      accessToken: 'token-1',
      maxJqlResults: 100,
    } as MCPToolContext,
    stubAuth()
  );

  return registered;
}

const written = () => calls.filter((call) => call.method === 'POST' || call.method === 'PUT');

// The field schema is cached per site for a day, so it outlives a test.
beforeEach(() => {
  clearFieldSchemaCache();
});

describe('jira_move_issue_to_sprint', () => {
  it('posts to the sprint, not a field update on the issue', async () => {
    serve();
    const move = (await sprintTools()).get('jira_move_issue_to_sprint')!;

    await move({ issueKey: 'CAS-23738', sprintId: '42' });

    expect(written()).toEqual([
      {
        url: 'https://api.atlassian.com/ex/jira/cloud-1/rest/agile/1.0/sprint/42/issue',
        method: 'POST',
        body: { issues: ['CAS-23738'] },
      },
    ]);
  });

  it('never writes a field called sprint', async () => {
    serve();
    const move = (await sprintTools()).get('jira_move_issue_to_sprint')!;

    await move({ issueKey: 'CAS-23738', sprintId: '42' });

    // The old implementation PUT `fields: { sprint: … }`, which is not a field
    // id, so Jira refused it on every project.
    expect(JSON.stringify(calls)).not.toContain('"fields"');
  });
});

describe('jira_bulk_move_sprint_issues', () => {
  it('moves the whole batch into a sprint with ONE request', async () => {
    serve();
    const bulk = (await sprintTools()).get('jira_bulk_move_sprint_issues')!;

    const result = await bulk({ issueKeys: ['CAS-1', 'CAS-2', 'CAS-3'], sprintId: '42' });

    expect(written()).toEqual([
      {
        url: 'https://api.atlassian.com/ex/jira/cloud-1/rest/agile/1.0/sprint/42/issue',
        method: 'POST',
        body: { issues: ['CAS-1', 'CAS-2', 'CAS-3'] },
      },
    ]);
    expect(result.content[0]?.text).toContain('3 issue(s) to sprint 42');
  });

  it('moves the whole batch to the backlog when sprintId is omitted', async () => {
    serve();
    const bulk = (await sprintTools()).get('jira_bulk_move_sprint_issues')!;

    const result = await bulk({ issueKeys: ['CAS-1', 'CAS-2'] });

    expect(written()).toEqual([
      {
        url: 'https://api.atlassian.com/ex/jira/cloud-1/rest/agile/1.0/backlog/issue',
        method: 'POST',
        body: { issues: ['CAS-1', 'CAS-2'] },
      },
    ]);
    expect(result.content[0]?.text).toContain('2 issue(s) to the backlog');
  });

  it('deduplicates issue keys before posting', async () => {
    serve();
    const bulk = (await sprintTools()).get('jira_bulk_move_sprint_issues')!;

    await bulk({ issueKeys: ['CAS-1', 'CAS-1', 'CAS-2'], sprintId: '42' });

    expect(written()[0]?.body).toEqual({ issues: ['CAS-1', 'CAS-2'] });
  });

  it('requires issue keys', async () => {
    serve();
    const bulk = (await sprintTools()).get('jira_bulk_move_sprint_issues')!;

    const result = await bulk({ issueKeys: [] });

    expect(result.isError).toBe(true);
    expect(written()).toEqual([]);
  });
});

describe('jira_remove_issue_from_sprint', () => {
  it('says there is nothing to remove when the issue is in no sprint', async () => {
    serve({ agileIssue: { fields: { sprint: null, closedSprints: [] } } });
    const remove = (await sprintTools()).get('jira_remove_issue_from_sprint')!;

    const result = await remove({ issueKey: 'CAS-23738' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('is not in a sprint');
    // Nothing is attempted, so nothing can be rejected confusingly.
    expect(written()).toEqual([]);
  });

  it('names the project boards, so "which board is it on" has an answer', async () => {
    serve({
      agileIssue: { fields: { sprint: null } },
      boards: [
        { id: 12, name: 'CAS Scrum' },
        { id: 13, name: 'CAS Kanban' },
      ],
    });
    const remove = (await sprintTools()).get('jira_remove_issue_from_sprint')!;

    const result = await remove({ issueKey: 'CAS-23738' });

    expect(result.content[0].text).toContain('CAS Scrum (12)');
    expect(result.content[0].text).toContain('CAS Kanban (13)');
  });

  it('reports closed sprints as history rather than something to remove', async () => {
    serve({
      agileIssue: { fields: { sprint: null, closedSprints: [{ name: 'Sprint 4' }] } },
    });
    const remove = (await sprintTools()).get('jira_remove_issue_from_sprint')!;

    const result = await remove({ issueKey: 'CAS-23738' });

    expect(result.content[0].text).toContain('Sprint 4');
    expect(result.content[0].text).toContain('closed');
    expect(written()).toEqual([]);
  });

  it('moves an issue in a sprint to the backlog, naming what it left', async () => {
    serve({ agileIssue: { fields: { sprint: { name: 'Sprint 7', id: 7 } } } });
    const remove = (await sprintTools()).get('jira_remove_issue_from_sprint')!;

    const result = await remove({ issueKey: 'SCRUM-1' });

    expect(written()).toEqual([
      {
        url: 'https://api.atlassian.com/ex/jira/cloud-1/rest/agile/1.0/backlog/issue',
        method: 'POST',
        body: { issues: ['SCRUM-1'] },
      },
    ]);
    expect(result.content[0].text).toContain('Sprint 7');
  });

  it('falls back to the Sprint field when the agile endpoint is unavailable', async () => {
    calls = [];
    jiraFetchMock.mockReset();
    jiraFetchMock.mockImplementation(
      async (url: string, request?: { method?: string; body?: string }) => {
        calls.push({
          url,
          method: request?.method ?? 'GET',
          body: request?.body ? JSON.parse(request.body) : null,
        });

        if (url.includes('/rest/agile/1.0/issue/')) throw new Error('Jira API 404: no agile');
        if (url.endsWith('/field')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array' }, custom: true },
            ],
          };
        }
        if (url.includes('/rest/api/3/issue/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ fields: { customfield_10020: [{ name: 'Sprint 9' }] } }),
          };
        }
        return { ok: true, status: 204, json: async () => ({}) };
      }
    );

    const remove = (await sprintTools()).get('jira_remove_issue_from_sprint')!;
    const result = await remove({ issueKey: 'SCRUM-2' });

    expect(result.content[0].text).toContain('Sprint 9');
    expect(written().map((call) => call.url)).toEqual([
      'https://api.atlassian.com/ex/jira/cloud-1/rest/agile/1.0/backlog/issue',
    ]);
  });

  it('still attempts the move when membership cannot be determined', async () => {
    // Neither source answered. Absence of evidence is not "no sprint", so the
    // request goes ahead and Jira decides.
    serve({ agileIssue: null });
    jiraFetchMock.mockImplementation(async (url: string, request?: { method?: string }) => {
      calls.push({ url, method: request?.method ?? 'GET', body: null });
      if (url.includes('/rest/agile/1.0/issue/')) throw new Error('nope');
      if (url.endsWith('/field')) throw new Error('nope');
      return { ok: true, status: 204, json: async () => ({}) };
    });

    const remove = (await sprintTools()).get('jira_remove_issue_from_sprint')!;
    const result = await remove({ issueKey: 'SCRUM-3' });

    expect(result.isError).toBeUndefined();
    expect(written().map((call) => call.url)).toContain(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/agile/1.0/backlog/issue'
    );
  });

  it('requires an issue key', async () => {
    serve();
    const remove = (await sprintTools()).get('jira_remove_issue_from_sprint')!;

    const result = await remove({});

    expect(result.isError).toBe(true);
    expect(written()).toEqual([]);
  });
});
