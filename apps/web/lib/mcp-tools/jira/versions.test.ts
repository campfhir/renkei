/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_create_version: create goes to POST /version with the numeric
 * projectId resolved from the key (the per-project path only answers GET),
 * and `released` — which Jira ignores on create — becomes a follow-up PUT.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (body: string) => body,
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { registerVersionTools } from './versions';
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
let responder: (call: Call) => { status: number; body: unknown };

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
      const { status, body } = responder(call);
      // jiraFetch throws on any non-2xx Atlassian answer (jira-auth.ts).
      if (status >= 400) throw new Error(`Jira API error ${status}`);
      return new Response(JSON.stringify(body), { status });
    },
  };
}

async function createVersion(): Promise<ToolHandler> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerVersionTools(
    server,
    { tenantId: 'tenant-1', accountId: 'acct-1' } as unknown as MCPToolContext,
    stubAuth()
  );
  return registered.get('jira_create_version')!;
}

const SEARCH_HIT = { values: [{ id: '10000', key: 'SCRUM', name: 'Scrum Team' }] };

function jiraSite(overrides: Partial<Record<string, (call: Call) => unknown>> = {}) {
  return (call: Call) => {
    if (call.path.startsWith('/rest/api/3/project/search')) {
      return { status: 200, body: overrides.search?.(call) ?? SEARCH_HIT };
    }
    if (call.method === 'POST' && call.path === '/rest/api/3/version') {
      return {
        status: 201,
        body: overrides.create?.(call) ?? {
          id: '10100',
          released: false,
          ...(call.body as object),
        },
      };
    }
    if (call.method === 'PUT' && call.path === '/rest/api/3/version/10100') {
      if (overrides.release) return { status: 200, body: overrides.release(call) };
      return { status: 200, body: { id: '10100', name: '1.0.0', released: true } };
    }
    return { status: 404, body: {} };
  };
}

beforeEach(() => {
  calls = [];
});

describe('jira_create_version', () => {
  it('creates via POST /version with the projectId resolved from the key', async () => {
    responder = jiraSite();
    const create = await createVersion();

    const result = await create({
      projectKey: 'scrum',
      name: '1.0.0',
      description: 'First cut',
      releaseDate: '2026-10-15',
    });

    expect(result.isError).toBeUndefined();
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/rest/api/3/version');
    expect(post?.body).toEqual({
      name: '1.0.0',
      projectId: 10000,
      description: 'First cut',
      releaseDate: '2026-10-15',
    });
    // Never the GET-only per-project path the tool used to POST to.
    expect(calls.some((call) => call.path.includes('/project/SCRUM/version'))).toBe(false);
    expect(post?.scopes).toContain('write:project-version:jira');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Version created: 1.0.0');
    expect(text).toContain('Project: SCRUM');
    expect(text).toContain('Released: false');
  });

  it('refuses an unknown project before writing anything', async () => {
    responder = jiraSite({ search: () => ({ values: [] }) });
    const create = await createVersion();

    const result = await create({ projectKey: 'NOPE', name: '1.0.0' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No project matches "NOPE"');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('releases with a follow-up PUT, since Jira ignores `released` on create', async () => {
    responder = jiraSite();
    const create = await createVersion();

    const result = await create({ projectKey: 'SCRUM', name: '1.0.0', released: true });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).not.toHaveProperty('released');
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe('/rest/api/3/version/10100');
    expect(put?.body).toEqual({ released: true });
    expect(result.content[0]?.text).toContain('Released: true');
  });

  it('reports a failed release without hiding that the version was created', async () => {
    responder = (call) => (call.method === 'PUT' ? { status: 400, body: {} } : jiraSite()(call));
    const create = await createVersion();

    const result = await create({ projectKey: 'SCRUM', name: '1.0.0', released: true });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Version created: 1.0.0');
    expect(text).toContain('Released: false');
    expect(text).toContain('Marking it released failed: Jira API error 400');
  });
});
