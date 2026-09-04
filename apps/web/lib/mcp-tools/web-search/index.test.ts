/**
 * web_search's contract: unconfigured orgs get a pointer to the admin page
 * rather than a call; the org allowlist is a ceiling a caller can narrow
 * within but never widen; per-call location overrides the org default;
 * provider failures come back as actionable text; and the rendered result
 * carries the answer, its sources and what was searched.
 */

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerWebSearchTools, narrowDomains, type WebSearchDeps } from './index';
import type { WebSearchConfig } from './config';
import type { WebSearchOutcome, WebSearchRequest } from './client';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

const config: WebSearchConfig = {
  baseUrl: 'https://res.openai.azure.com/openai/v1',
  apiKey: 'k',
  model: 'gpt-5.5',
  apiVersion: null,
  reasoningEffort: null,
  userLocation: { country: 'US', city: 'Chicago' },
  allowedDomains: [],
  blockedDomains: [],
};

function okOutcome(overrides: Partial<Extract<WebSearchOutcome, { ok: true }>['val']> = {}) {
  return {
    ok: true as const,
    val: {
      text: 'Answer text.',
      citations: [{ url: 'https://example.org/a', title: 'A' }],
      queries: ['q'],
      sources: [],
      searched: true,
      status: null,
      ...overrides,
    },
  };
}

function setup(
  resolved: WebSearchConfig | null,
  outcome: WebSearchOutcome = okOutcome()
): {
  handler: Handler;
  search: jest.Mock<Promise<WebSearchOutcome>, [WebSearchConfig, WebSearchRequest]>;
} {
  const search = jest.fn<Promise<WebSearchOutcome>, [WebSearchConfig, WebSearchRequest]>(
    async () => outcome
  );
  const deps: WebSearchDeps = { resolveConfig: async () => resolved, search };
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  const context: MCPToolContext = {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    subject: 'auth0|alice',
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  registerWebSearchTools(server as unknown as McpServer, context, deps);
  return { handler: handlers.get('web_search')!, search };
}

test('registers web_search as a read tool', () => {
  const registered: Array<{ name: string; config: { annotations?: { readOnlyHint?: boolean } } }> =
    [];
  const server = {
    registerTool: (name: string, config: { annotations?: { readOnlyHint?: boolean } }) => {
      registered.push({ name, config });
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  registerWebSearchTools(server as unknown as McpServer, {
    tenantId: 't',
    accountId: '',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 1,
  });
  expect(registered.map((entry) => entry.name)).toEqual(['web_search']);
  expect(registered[0]?.config.annotations?.readOnlyHint).toBe(true);
});

test('points at the admin page when the org has not configured web search', async () => {
  const { handler, search } = setup(null);
  const result = await handler({ query: 'anything' });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('Connector setup');
  expect(search).not.toHaveBeenCalled();
});

test('rejects an empty query before touching the provider', async () => {
  const { handler, search } = setup(config);
  const result = await handler({ query: '   ' });
  expect(result.isError).toBe(true);
  expect(search).not.toHaveBeenCalled();
});

test('renders the answer, its sources and the queries run', async () => {
  const { handler, search } = setup(config);
  const result = await handler({ query: 'renewable energy trends' });
  expect(result.isError).toBeUndefined();
  const text = result.content[0]?.text ?? '';
  expect(text).toContain('Answer text.');
  expect(text).toContain('Sources:');
  expect(text).toContain('1. A — https://example.org/a');
  expect(text).toContain('Searched for: "q"');
  expect(search).toHaveBeenCalledWith(config, { query: 'renewable energy trends' });
});

test('passes a per-call location through, normalized', async () => {
  const { handler, search } = setup(config);
  await handler({ query: 'weather', location: { country: 'gb', city: ' Leeds ' } });
  expect(search.mock.calls[0]?.[1]).toEqual({
    query: 'weather',
    location: { country: 'GB', city: 'Leeds' },
  });
});

test('caller domains narrow within the org allowlist and never widen it', async () => {
  const org = { ...config, allowedDomains: ['who.int', 'cdc.gov'] };
  const { handler, search } = setup(org);
  const result = await handler({
    query: 'q',
    domains: ['https://www.who.int/news', 'reddit.com', 'not a host'],
  });
  expect(search.mock.calls[0]?.[1]).toEqual({ query: 'q', allowedDomains: ['www.who.int'] });
  const text = result.content[0]?.text ?? '';
  expect(text).toContain('Ignored domains');
  expect(text).toContain('reddit.com');
});

test('refuses when every caller domain falls outside the org allowlist', async () => {
  const org = { ...config, allowedDomains: ['who.int'] };
  const { handler, search } = setup(org);
  const result = await handler({ query: 'q', domains: ['reddit.com'] });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('who.int');
  expect(search).not.toHaveBeenCalled();
});

test('without an org allowlist, caller domains pass through as given', async () => {
  const { handler, search } = setup(config);
  await handler({ query: 'q', domains: ['learn.microsoft.com'] });
  expect(search.mock.calls[0]?.[1]).toEqual({
    query: 'q',
    allowedDomains: ['learn.microsoft.com'],
  });
});

test('flags a reply that never actually searched', async () => {
  const { handler } = setup(config, okOutcome({ searched: false, citations: [], queries: [] }));
  const text = (await handler({ query: 'q' })).content[0]?.text ?? '';
  expect(text).toContain('WITHOUT performing a web search');
  expect(text).not.toContain('Sources:');
});

test('turns an auth failure into an admin-facing message', async () => {
  const { handler } = setup(config, {
    ok: false,
    error: { kind: 'auth', message: 'Web-search endpoint 401: bad key' },
  });
  const result = await handler({ query: 'q' });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("organization's API key");
  expect(result.content[0]?.text).toContain('bad key');
});

test('turns a missing deployment into a config hint', async () => {
  const { handler } = setup(config, {
    ok: false,
    error: { kind: 'not_found', message: 'Web-search endpoint 404: no deployment' },
  });
  const result = await handler({ query: 'q' });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('deployment name');
});

describe('narrowDomains', () => {
  it('normalizes and dedupes, keeping subdomains of allowed hosts', () => {
    expect(
      narrowDomains(['HTTPS://Docs.who.int/x', 'docs.who.int', 'who.int'], ['who.int'])
    ).toEqual({
      allowed: ['docs.who.int', 'who.int'],
      rejected: [],
    });
  });
  it('rejects hosts outside the ceiling and non-hosts', () => {
    expect(narrowDomains(['evil-who.int', 'nope'], ['who.int'])).toEqual({
      allowed: [],
      rejected: ['evil-who.int', 'nope'],
    });
  });
});
