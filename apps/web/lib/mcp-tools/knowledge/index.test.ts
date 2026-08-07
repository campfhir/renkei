/**
 * search_knowledge's contract: read-only, fails closed without a recorded
 * email (nothing can be verified → nothing disclosed), reports the
 * unconfigured knowledge layer plainly, and always surfaces the gate's
 * elided count — withheld results are counted, never silently dropped.
 */

jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
  searchKnowledge: jest.fn(),
}));
jest.mock('@renkei/connector-config', () => ({
  readConnectorConfigCached: jest.fn(async () => ({ ok: true, val: null })),
}));
jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: jest.fn(() => ({ ok: true, val: Buffer.alloc(32) })),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerKnowledgeTools } from './index';
import type { MCPToolContext } from '../common';

const { resolveEmbeddingProvider: mockResolveEmbedder, searchKnowledge: mockSearch } =
  jest.requireMock<{ resolveEmbeddingProvider: jest.Mock; searchKnowledge: jest.Mock }>(
    '@renkei/knowledge'
  );

interface Registered {
  config: { annotations?: { readOnlyHint?: boolean } };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
}

async function register(context: Partial<MCPToolContext>): Promise<Registered> {
  let registered: Registered | null = null;
  const server = {
    registerTool: (
      _name: string,
      config: Registered['config'],
      handler: Registered['handler']
    ) => {
      registered = { config, handler };
    },
  };
  // The stub covers exactly the slice of McpServer the module uses.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  await registerKnowledgeTools(server as unknown as McpServer, {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    ...context,
  });
  if (!registered) throw new Error('search_knowledge was not registered');
  return registered;
}

beforeEach(() => {
  mockResolveEmbedder.mockReset();
  mockSearch.mockReset();
});

describe('registerKnowledgeTools', () => {
  it('registers search_knowledge as read-only', async () => {
    const { config } = await register({ userEmail: 'sam@example.com' });
    expect(config.annotations?.readOnlyHint).toBe(true);
  });

  it('fails closed when the caller has no recorded email', async () => {
    const { handler } = await register({ userEmail: undefined });
    const result = await handler({ query: 'quarterly report' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no email on record');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('reports an unconfigured knowledge layer plainly', async () => {
    mockResolveEmbedder.mockResolvedValue(null);
    const { handler } = await register({ userEmail: 'sam@example.com' });
    const result = await handler({ query: 'quarterly report' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not configured');
  });

  it('returns hits and always reports the elided count', async () => {
    mockResolveEmbedder.mockResolvedValue({ embed: async () => ({ ok: true, val: [[0.1]] }) });
    mockSearch.mockResolvedValue({
      ok: true,
      val: {
        hits: [
          {
            provider: 'webex',
            refId: 'room-1/msg-1',
            content: 'The Q4 revenue cycle report lives in the finance space.',
            metadata: {},
            distance: 0.1234567,
          },
        ],
        elided: 2,
      },
    });
    const { handler } = await register({ userEmail: 'sam@example.com' });

    const result = await handler({ query: 'where is the Q4 report?', k: 3 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('[webex:room-1/msg-1]');
    expect(text).toContain('distance 0.123');
    expect(text).toContain('2 result(s) withheld');

    const searchArgs = mockSearch.mock.calls[0]?.[0];
    expect(searchArgs.userEmail).toBe('sam@example.com');
    expect(searchArgs.tenantId).toBe('tenant-1');
    expect(searchArgs.k).toBe(3);
  });

  it('says "no accessible results" when the gate clears nothing', async () => {
    mockResolveEmbedder.mockResolvedValue({ embed: async () => ({ ok: true, val: [[0.1]] }) });
    mockSearch.mockResolvedValue({ ok: true, val: { hits: [], elided: 3 } });
    const { handler } = await register({ userEmail: 'outsider@example.com' });

    const result = await handler({ query: 'secret plans' });

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No accessible results');
    expect(text).toContain('3 result(s) withheld');
  });

  it('surfaces a search failure as a tool error', async () => {
    mockResolveEmbedder.mockResolvedValue({ embed: async () => ({ ok: true, val: [[0.1]] }) });
    mockSearch.mockResolvedValue({ ok: false, err: { type: 'EMBEDDING_FAILED' } });
    const { handler } = await register({ userEmail: 'sam@example.com' });

    const result = await handler({ query: 'anything' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('embedding provider');
  });
});
