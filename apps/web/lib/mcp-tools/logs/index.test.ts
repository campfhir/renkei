/**
 * log_search's contract: self-scoped to the caller's own Jira-linked
 * account by default, fails closed without a subject or a Jira grant,
 * widens to a tenant-wide search only for a caller whose context.roles
 * includes renkei-operator (undefined/empty roles stay self-scoped), and
 * never renders the secure()-marked request/response body attributes back
 * to the model in either branch.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/log-encryption', () => ({ resolveLogCipher: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('@campfhir/bored-logs/adapters/psql', () => ({
  PostgresAdapter: jest.fn().mockImplementation((opts: unknown) => ({
    opts,
    query: mockQuery,
  })),
}));

const mockBuildLogQueryOptions = jest.fn((..._args: unknown[]) => ({ built: true }));
jest.mock('@/lib/log-query', () => ({
  buildLogQueryOptions: (...args: unknown[]) => mockBuildLogQueryOptions(...args),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { FilterExpr } from '@campfhir/bored-logs';

/** Narrows one recorded call's first argument, for the assertions that need to walk the tree. */
function firstCallFilter(): FilterExpr | null {
  const [combined] = mockBuildLogQueryOptions.mock.calls[0]!;
  const isFilterExpr = (value: unknown): value is FilterExpr =>
    typeof value === 'object' && value !== null && 'type' in value;
  return isFilterExpr(combined) ? combined : null;
}
import { registerLogTools } from './index';
import type { MCPToolContext } from '../common';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { resolveLogCipher: mockResolveLogCipher } = jest.requireMock<{
  resolveLogCipher: jest.Mock;
}>('@/lib/log-encryption');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function registerAll(context: Partial<MCPToolContext>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  registerLogTools(server as unknown as McpServer, {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    subject: 'auth0|alice',
    ...context,
  });
  return handlers;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDatabase.mockReturnValue({ ok: true, val: { database: 'stub' } });
  mockResolveLogCipher.mockReturnValue({ state: 'off' });
  mockBuildLogQueryOptions.mockReturnValue({ built: true });
});

test('fails closed without a subject', async () => {
  const handlers = registerAll({ subject: undefined });
  const result = await handlers.get('log_search')!({});
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('no recorded identity');
  expect(mockQuery).not.toHaveBeenCalled();
});

test('fails closed without a Jira-linked account, never widening to the tenant', async () => {
  const handlers = registerAll({ accountId: '' });
  const result = await handlers.get('log_search')!({});
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('Connect Jira first');
  expect(mockQuery).not.toHaveBeenCalled();
});

test('scopes the query to the caller’s own tenant and account, never a client-supplied one', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({ tenantId: 'tenant-1', accountId: 'account-1' });

  await handlers.get('log_search')!({});

  expect(mockBuildLogQueryOptions).toHaveBeenCalledWith(
    null,
    'tenant-1',
    'account-1',
    expect.objectContaining({ levels: ['warn', 'error', 'critical'], sort: 'desc' })
  );
});

test('a renkei-user role (no operator) stays self-scoped, same as no roles at all', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({ roles: ['renkei-user'] });

  await handlers.get('log_search')!({});

  expect(mockBuildLogQueryOptions).toHaveBeenCalledWith(
    null,
    'tenant-1',
    'account-1',
    expect.anything()
  );
});

test('renkei-operator searches the whole tenant, with no Jira account required', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({ accountId: '', roles: ['renkei-operator'] });

  const result = await handlers.get('log_search')!({});

  expect(result.isError).toBeUndefined();
  expect(mockBuildLogQueryOptions).toHaveBeenCalledWith(
    null,
    'tenant-1',
    undefined,
    expect.anything()
  );
  expect(result.content[0]?.text).toContain('tenant-wide');
});

test('an operator with their own Jira account still searches tenant-wide, not just their own', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({ accountId: 'account-1', roles: ['renkei-operator'] });

  await handlers.get('log_search')!({});

  expect(mockBuildLogQueryOptions).toHaveBeenCalledWith(
    null,
    'tenant-1',
    undefined,
    expect.anything()
  );
});

test('operator rows are labeled with whose activity they are; self-scoped rows are not', async () => {
  const rowFor = (subject: string) => ({
    id: `log-${subject}`,
    timestamp: '2026-08-28T09:00:00.000Z',
    level: 'error' as const,
    message: 'Non-OK response',
    meta: { component: 'jira/fetch', subject, accountId: 'acct-x', displayName: 'Alice' },
  });

  mockQuery.mockResolvedValue({ ok: true, val: [rowFor('auth0|alice')] });
  const operatorHandlers = registerAll({ roles: ['renkei-operator'] });
  const operatorText = (await operatorHandlers.get('log_search')!({})).content[0]?.text ?? '';
  expect(operatorText).toContain('subject=auth0|alice');
  expect(operatorText).toContain('accountId=acct-x');
  expect(operatorText).toContain('displayName=Alice');

  mockQuery.mockResolvedValue({ ok: true, val: [rowFor('auth0|alice')] });
  const selfHandlers = registerAll({});
  const selfText = (await selfHandlers.get('log_search')!({})).content[0]?.text ?? '';
  expect(selfText).not.toContain('subject=');
  expect(selfText).not.toContain('accountId=');
  expect(selfText).not.toContain('displayName=');
});

test('renders rows but never the secure()-marked body/claim attributes', async () => {
  mockQuery.mockResolvedValue({
    ok: true,
    val: [
      {
        id: 'log-1',
        timestamp: '2026-08-28T09:00:00.000Z',
        level: 'error',
        message: 'Non-OK response',
        meta: {
          component: 'jira/fetch',
          status: 500,
          tenantId: 'tenant-1',
          accountId: 'account-1',
          subject: 'auth0|alice',
          requestBody: 'super-secret-payload',
          responseBody: 'another-secret-payload',
          tokenClaims: { aud: 'atlassian' },
        },
      },
    ],
  });
  const handlers = registerAll({});

  const text = (await handlers.get('log_search')!({})).content[0]?.text ?? '';

  expect(text).toContain('[error] 2026-08-28T09:00:00.000Z — Non-OK response');
  expect(text).toContain('component=jira/fetch');
  expect(text).toContain('status=500');
  expect(text).not.toContain('super-secret-payload');
  expect(text).not.toContain('another-secret-payload');
  expect(text).not.toContain('tokenClaims');
  expect(text).not.toContain('auth0|alice');
});

test('reports a clean error when the underlying query fails', async () => {
  mockQuery.mockResolvedValue({ ok: false, err: { message: 'adapter exploded' } });
  const handlers = registerAll({});

  const result = await handlers.get('log_search')!({});

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('adapter exploded');
});

test('an explicit limit is clamped into range and passed through', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({});

  await handlers.get('log_search')!({ limit: 500 });

  expect(mockBuildLogQueryOptions).toHaveBeenCalledWith(
    null,
    'tenant-1',
    'account-1',
    expect.objectContaining({ limit: 100 })
  );
});

test('a structured filter compiles to the FilterExpr tree the query engine reads', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({});

  await handlers.get('log_search')!({
    filter: {
      and: [
        { key: 'status', op: 'gte', value: 500 },
        { key: 'component', op: 'eq', value: 'jira/fetch' },
      ],
    },
  });

  expect(mockBuildLogQueryOptions).toHaveBeenCalledWith(
    {
      type: 'and',
      nodes: [
        { type: 'filter', filter: { key: 'status', operator: '>=', value: '500' } },
        { type: 'filter', filter: { key: 'component', operator: '=', value: 'jira/fetch' } },
      ],
    },
    'tenant-1',
    'account-1',
    expect.anything()
  );
});

test('isNull/isNotNull leaves carry no value', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({});

  await handlers.get('log_search')!({ filter: { key: 'errorCode', op: 'isNotNull' } });

  expect(mockBuildLogQueryOptions).toHaveBeenCalledWith(
    {
      type: 'filter',
      filter: { key: 'errorCode', operator: '=', value: 'null', nullValue: true, negated: true },
    },
    'tenant-1',
    'account-1',
    expect.anything()
  );
});

test('filter and query combine with AND when both are given', async () => {
  mockQuery.mockResolvedValue({ ok: true, val: [] });
  const handlers = registerAll({});

  await handlers.get('log_search')!({
    filter: { key: 'component', op: 'eq', value: 'jira/fetch' },
    query: 'level:error',
  });

  const combined = firstCallFilter();
  if (!combined || combined.type !== 'and') {
    throw new Error('expected an "and" node combining filter and query');
  }
  expect(combined.nodes).toHaveLength(2);
  expect(combined.nodes[0]).toEqual({
    type: 'filter',
    filter: { key: 'component', operator: '=', value: 'jira/fetch' },
  });
});

test('rejects a filter leaf missing its value with a clear message, never silently matching everything', async () => {
  const handlers = registerAll({});

  const result = await handlers.get('log_search')!({ filter: { key: 'status', op: 'eq' } });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('value is required');
  expect(mockQuery).not.toHaveBeenCalled();
});

test('rejects malformed query syntax with a clear message, never silently matching everything', async () => {
  const handlers = registerAll({});

  const result = await handlers.get('log_search')!({ query: '&& foo' });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('Could not parse "query"');
  expect(mockQuery).not.toHaveBeenCalled();
});
