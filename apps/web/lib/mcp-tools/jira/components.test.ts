/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_create_component: create goes to POST /component with the project
 * KEY in the body (the per-project path only answers GET), and the lead is
 * resolved to an accountId — Jira Cloud has no user keys.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Tester',
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { registerComponentTools } from './components';
import type { JiraAuth } from './jira-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  method: string;
  path: string;
  body?: unknown;
  scopes: readonly string[];
}

let calls: Call[] = [];
let users: unknown[] = [];

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: async (scopes, path, init) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        scopes,
      };
      calls.push(call);
      if (path.startsWith('/rest/api/3/project/search')) {
        return Response.json({ values: [{ id: '10000', key: 'SCRUM', name: 'Scrum Team' }] });
      }
      if (path.startsWith('/rest/api/3/user/search')) return Response.json(users);
      if (call.method === 'POST' && path === '/rest/api/3/component') {
        const body = call.body as Record<string, unknown>;
        return Response.json(
          {
            id: '10200',
            ...body,
            lead: body.leadAccountId ? { displayName: 'Dana Lead' } : undefined,
          },
          { status: 201 }
        );
      }
      throw new Error(`Jira API error 404 for ${path}`);
    },
  };
}

async function createComponent(): Promise<ToolHandler> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerComponentTools(
    server,
    { tenantId: 'tenant-1', accountId: 'acct-1' } as unknown as MCPToolContext,
    stubAuth()
  );
  return registered.get('jira_create_component')!;
}

beforeEach(() => {
  calls = [];
  users = [];
});

describe('jira_create_component', () => {
  it('creates via POST /component with the resolved project key in the body', async () => {
    const create = await createComponent();

    const result = await create({ projectKey: 'scrum', name: 'Billing', description: 'Invoices' });

    expect(result.isError).toBeUndefined();
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/rest/api/3/component');
    expect(post?.body).toEqual({ name: 'Billing', project: 'SCRUM', description: 'Invoices' });
    expect(calls.some((call) => call.path.includes('/project/scrum/component'))).toBe(false);
    expect(post?.scopes).toContain('write:project.component:jira');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Component created: Billing');
    expect(text).toContain('Project: SCRUM');
  });

  it('resolves a lead email to leadAccountId', async () => {
    users = [
      { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Dana', emailAddress: 'dana@x.org' },
    ];
    const create = await createComponent();

    const result = await create({ projectKey: 'SCRUM', name: 'Billing', lead: 'dana@x.org' });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ leadAccountId: '5b10ac8d82e05b22cc7d4ef5' });
    expect(post?.body).not.toHaveProperty('leadUserKey');
    expect(result.content[0]?.text).toContain('Lead: Dana Lead');
  });

  it('passes an accountId lead through without a directory search', async () => {
    const create = await createComponent();

    await create({ projectKey: 'SCRUM', name: 'Billing', lead: '5b10ac8d82e05b22cc7d4ef5' });

    expect(calls.some((call) => call.path.startsWith('/rest/api/3/user/search'))).toBe(false);
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      leadAccountId: '5b10ac8d82e05b22cc7d4ef5',
    });
  });

  it('refuses an unresolvable lead before creating anything', async () => {
    users = [];
    const create = await createComponent();

    const result = await create({ projectKey: 'SCRUM', name: 'Billing', lead: 'ghost@x.org' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Component lead: no Jira user matches "ghost@x.org"');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
