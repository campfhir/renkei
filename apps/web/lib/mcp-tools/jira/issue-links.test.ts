/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_create_remote_link: the Links-panel web link. What must hold: the
 * documented remotelink body shape (object.url/title, globalId at the top
 * level), the created/updated distinction Jira signals by status code, and
 * the absolute-URL guard — Jira's own rejection for a bare "docs/spec" is
 * an opaque 400.
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

import { registerIssueLinkTools } from './issue-links';
import type { JiraAuth } from './jira-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let responseStatus = 201;

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: async (_scopes, path, init) => {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return new Response('{}', { status: responseStatus });
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
  await registerIssueLinkTools(
    server,
    { tenantId: 'tenant-1', accountId: 'acct-1' } as unknown as MCPToolContext,
    stubAuth()
  );
  return registered;
}

beforeEach(() => {
  calls = [];
  responseStatus = 201;
});

describe('jira_create_remote_link', () => {
  it('posts the documented remotelink shape to the issue', async () => {
    const create = (await tools()).get('jira_create_remote_link')!;

    const result = await create({
      issueKey: 'ENG-698',
      url: 'https://docs.example.com/spec',
      title: 'Wait-time spec',
      summary: 'Design doc',
      relationship: 'documentation for',
      globalId: 'renkei:spec:wait-time',
    });

    expect(calls).toEqual([
      {
        path: '/rest/api/3/issue/ENG-698/remotelink',
        method: 'POST',
        body: {
          globalId: 'renkei:spec:wait-time',
          relationship: 'documentation for',
          object: {
            url: 'https://docs.example.com/spec',
            title: 'Wait-time spec',
            summary: 'Design doc',
          },
        },
      },
    ]);
    expect(result.content[0]?.text).toContain('Added web link on ENG-698');
  });

  it('reports an update when Jira answers 200 for a reused globalId', async () => {
    responseStatus = 200;
    const create = (await tools()).get('jira_create_remote_link')!;

    const result = await create({
      issueKey: 'ENG-698',
      url: 'https://docs.example.com/spec-v2',
      title: 'Wait-time spec v2',
      globalId: 'renkei:spec:wait-time',
    });

    expect(result.content[0]?.text).toContain('Updated web link on ENG-698');
  });

  it('rejects a relative URL before Jira answers an opaque 400', async () => {
    const create = (await tools()).get('jira_create_remote_link')!;

    const result = await create({ issueKey: 'ENG-698', url: 'docs/spec', title: 'Spec' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('absolute http(s) URL');
    expect(calls).toEqual([]);
  });

  it('requires issueKey, url, and title', async () => {
    const create = (await tools()).get('jira_create_remote_link')!;

    const result = await create({ issueKey: 'ENG-698', url: 'https://x.example' });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
