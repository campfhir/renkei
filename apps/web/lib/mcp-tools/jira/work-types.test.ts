/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_list_work_types: global vs project-scoped listing, key-to-id
 * resolution via project search, and the numeric-id fast path that skips
 * resolution entirely.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (body: string, suggestion: string) =>
    `${body}\n\n(Presentation hint: ${suggestion})`,
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { registerWorkTypeTools } from './work-types';
import type { JiraAuth } from './jira-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  path: string;
}

let calls: Call[] = [];
let responder: (path: string) => { status: number; body: unknown };

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: async (_scopes, path) => {
      calls.push({ path });
      const { status, body } = responder(path);
      return new Response(JSON.stringify(body), { status });
    },
  };
}

async function tools(): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerWorkTypeTools(
    server,
    { tenantId: 'tenant-1', accountId: 'acct-1' } as unknown as MCPToolContext,
    stubAuth()
  );
  return registered;
}

const TASK = { id: '3', name: 'Task', subtask: false, hierarchyLevel: 0, description: 'A task.' };
const SUBTASK = { id: '5', name: 'Subtask', subtask: true, hierarchyLevel: -1, description: '' };
const SERVICE_REQUEST = {
  id: '10001',
  name: '[System] Service request',
  subtask: false,
  hierarchyLevel: 0,
  description: 'A request from a customer.',
};

beforeEach(() => {
  calls = [];
});

describe('jira_list_work_types', () => {
  it('lists every visible work type when no project is given', async () => {
    responder = () => ({ status: 200, body: [TASK, SUBTASK] });
    const list = (await tools()).get('jira_list_work_types')!;

    const result = await list({});

    expect(calls).toEqual([{ path: '/rest/api/3/issuetype' }]);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('2 work type(s) visible to you:');
    expect(text).toContain('• Task (3) — hierarchy: Standard — A task.');
    expect(text).toContain('• Subtask (5) — subtask — hierarchy: Subtask');
  });

  it('scopes to a project by numeric ID without resolving a key', async () => {
    responder = () => ({ status: 200, body: [SERVICE_REQUEST] });
    const list = (await tools()).get('jira_list_work_types')!;

    const result = await list({ projectIdOrKey: '10000' });

    expect(calls).toEqual([{ path: '/rest/api/3/issuetype/project?projectId=10000' }]);
    expect(result.content[0]?.text).toContain('work type(s) for project 10000');
  });

  it('resolves a project key to its ID via project search, then lists its work types', async () => {
    responder = (path) => {
      if (path.startsWith('/rest/api/3/project/search')) {
        return {
          status: 200,
          body: { values: [{ id: '10000', key: 'SD', name: 'Service Desk' }] },
        };
      }
      return { status: 200, body: [SERVICE_REQUEST] };
    };
    const list = (await tools()).get('jira_list_work_types')!;

    const result = await list({ projectIdOrKey: 'sd' });

    expect(calls).toEqual([
      { path: '/rest/api/3/project/search?query=sd&maxResults=50' },
      { path: '/rest/api/3/issuetype/project?projectId=10000' },
    ]);
    expect(result.content[0]?.text).toContain('work type(s) for project Service Desk (SD)');
  });

  it('errors instead of guessing when no project matches the key', async () => {
    responder = () => ({ status: 200, body: { values: [] } });
    const list = (await tools()).get('jira_list_work_types')!;

    const result = await list({ projectIdOrKey: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No project matches "nope"');
    expect(calls).toEqual([{ path: '/rest/api/3/project/search?query=nope&maxResults=50' }]);
  });

  it('reports the API error text on a non-ok response', async () => {
    responder = () => ({ status: 403, body: { message: 'Forbidden' } });
    const list = (await tools()).get('jira_list_work_types')!;

    const result = await list({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Forbidden');
  });
});
