/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (text: string) => text,
}));

import { registerCommentTools, renderComment } from './comments';
import type { JiraAuth } from './jira-auth';

const apiBaseUrl = 'https://api.atlassian.com/ex/jira/cloud-1';

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: (_requiredScopes, path, init) => jiraFetchMock(`${apiBaseUrl}${path}`, init),
  };
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];

/** A paragraph-only ADF document, the shape Jira hands back for a comment body. */
function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** A body well past the 300 characters the old renderer clipped at. */
const LONG = Array.from(
  { length: 12 },
  (_, i) => `Line ${i + 1}: something happened at 18:5${i % 10}`
).join(' ');

function comment(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: { displayName: 'Austin Zhong' },
    created: '2026-09-16T18:56:12.345-0700',
    updated: '2026-09-16T18:56:12.345-0700',
    body: adf(text),
    ...extra,
  };
}

function serve(response: Record<string, unknown>): void {
  calls = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(
    async (url: string, request?: { method?: string; body?: string }) => {
      calls.push({
        url,
        method: request?.method ?? 'GET',
        body: request?.body ? JSON.parse(request.body) : null,
      });
      return { ok: true, status: 200, json: async () => response };
    }
  );
}

async function tools(): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerCommentTools(
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

const text = (result: ToolResult) => result.content[0]?.text ?? '';

describe('renderComment', () => {
  it('prints the whole body, the id and the visibility marker', () => {
    const rendered = renderComment(comment('42', LONG, { jsdPublic: false }));
    expect(rendered).toContain(LONG);
    expect(rendered).not.toContain('…');
    expect(rendered).toContain('(ID: 42)');
    expect(rendered).toContain('[internal]');
    expect(rendered).toContain('Austin Zhong');
  });

  it('keeps the created timestamp as Jira reports it, offset included', () => {
    // toLocaleString() printed a server-local time with no zone marker,
    // which is exactly how a UTC-vs-Pacific mix-up starts.
    expect(renderComment(comment('1', 'hi'))).toContain('2026-09-16T18:56:12.345-0700');
  });

  it('notes an edit only when the timestamps differ', () => {
    expect(renderComment(comment('1', 'hi'))).not.toContain('edited');
    expect(
      renderComment(comment('1', 'hi', { updated: '2026-09-17T09:00:00.000-0700' }))
    ).toContain('edited 2026-09-17T09:00:00.000-0700');
  });
});

describe('jira_list_comments', () => {
  it('returns every comment body in full', async () => {
    serve({
      startAt: 0,
      maxResults: 50,
      total: 2,
      comments: [comment('1', LONG), comment('2', 'short')],
    });
    const result = await (await tools()).get('jira_list_comments')!({ issueKey: 'CAS-25094' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Issue CAS-25094 has 2 comments:');
    expect(text(result)).toContain(LONG);
    expect(text(result)).toContain('(ID: 1)');
    expect(text(result)).toContain('(ID: 2)');
    expect(text(result)).not.toContain('…');
  });

  it('asks Jira for a page oldest-first and forwards the paging arguments', async () => {
    serve({ startAt: 50, maxResults: 25, total: 80, comments: [comment('51', 'a')] });
    await (await tools()).get('jira_list_comments')!({
      issueKey: 'CAS-25094',
      startAt: 50,
      maxResults: 25,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/ex/jira/cloud-1/rest/api/3/issue/CAS-25094/comment');
    expect(url.searchParams.get('startAt')).toBe('50');
    expect(url.searchParams.get('maxResults')).toBe('25');
    expect(url.searchParams.get('orderBy')).toBe('created');
  });

  it('says how to reach the rest of a long thread', async () => {
    serve({
      startAt: 0,
      maxResults: 2,
      total: 5,
      comments: [comment('1', 'a'), comment('2', 'b')],
    });
    const result = await (await tools()).get('jira_list_comments')!({
      issueKey: 'CAS-25094',
      maxResults: 2,
    });
    expect(text(result)).toContain(
      'has 5 comments; showing 1–2 (pass startAt=2 for the next page)'
    );
  });

  it('caps the page size at what Jira accepts', async () => {
    serve({ startAt: 0, maxResults: 100, total: 0, comments: [] });
    await (await tools()).get('jira_list_comments')!({ issueKey: 'CAS-1', maxResults: 5000 });
    expect(new URL(calls[0].url).searchParams.get('maxResults')).toBe('100');
  });

  it('reports an empty thread plainly', async () => {
    serve({ startAt: 0, maxResults: 50, total: 0, comments: [] });
    const result = await (await tools()).get('jira_list_comments')!({ issueKey: 'CAS-1' });
    expect(text(result)).toBe('Issue CAS-1 has no comments.');
  });
});

describe('jira_bulk_get_comments', () => {
  it('returns full bodies for the ids it was given', async () => {
    serve({ values: [comment('7', LONG, { jsdPublic: true })] });
    const result = await (await tools()).get('jira_bulk_get_comments')!({ commentIds: ['7'] });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ ids: [7] });
    expect(text(result)).toContain('Retrieved 1 comment:');
    expect(text(result)).toContain(LONG);
    expect(text(result)).toContain('[portal]');
    expect(text(result)).not.toContain('…');
  });
});
