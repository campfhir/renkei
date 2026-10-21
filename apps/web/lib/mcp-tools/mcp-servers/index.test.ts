/* eslint-disable @typescript-eslint/consistent-type-assertions -- a collecting stand-in for McpServer */
import type { McpServer } from '@modelcontextprotocol/server';
import { McpAuthRequired } from '@renkei/connector-mcp';
import type { MCPToolContext } from '../common';
import { passthroughSchema, registerMcpServerTools, registeredNames } from './index';

const callRemoteTool = jest.fn();
jest.mock('@/lib/mcp-servers/remote', () => ({
  callRemoteTool: (...args: unknown[]) => callRemoteTool(...args),
  refreshInBackground: jest.fn(),
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));

interface Registered {
  name: string;
  config: { title?: string; description?: string; annotations?: { readOnlyHint?: boolean } };
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text?: string }[];
    isError?: boolean;
  }>;
}

function collector(): { server: McpServer; tools: Registered[] } {
  const tools: Registered[] = [];
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Registered['handler']) => {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

const entry = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme Docs',
  url: 'https://mcp.acme.test/mcp',
  transport: 'streamable_http' as const,
  tools: [
    { name: 'search', description: 'Search docs', inputSchema: { type: 'object' }, readOnly: true },
    { name: 'file doc', description: '', inputSchema: { type: 'object' }, readOnly: false },
  ],
};
const context = { subject: 'u1' } as MCPToolContext;

beforeEach(() => callRemoteTool.mockReset());

describe('registerMcpServerTools', () => {
  it('registers each listed tool under the server’s name, reads as reads and the rest as acts', () => {
    const { server, tools } = collector();
    registerMcpServerTools(server, context, entry);
    expect(tools.map((tool) => tool.name)).toEqual(['acme__search', 'acme__file_doc']);
    expect(tools[0].config.annotations?.readOnlyHint).toBe(true);
    expect(tools[1].config.annotations?.readOnlyHint).toBe(false);
    expect(tools[0].config.description).toBe('[Acme Docs] Search docs');
    expect(tools[1].config.title).toBe('Acme Docs · Act — file doc');
  });

  it('forwards a call to the server as the person, under the tool’s own name', async () => {
    callRemoteTool.mockResolvedValue({
      content: [{ type: 'text', text: 'found it' }],
      isError: false,
    });
    const { server, tools } = collector();
    registerMcpServerTools(server, context, entry);
    const result = await tools[0].handler({ q: 'x' });
    expect(callRemoteTool).toHaveBeenCalledWith(entry, 'u1', 'search', { q: 'x' });
    expect(result.content[0].text).toBe('found it');
    expect(result.isError).toBeUndefined();
  });

  it('relays a server-reported error as an error result', async () => {
    callRemoteTool.mockResolvedValue({ content: [{ type: 'text', text: 'nope' }], isError: true });
    const { server, tools } = collector();
    registerMcpServerTools(server, context, entry);
    expect((await tools[0].handler({})).isError).toBe(true);
  });

  it('tells the person to reconnect when the server wants authorization', async () => {
    callRemoteTool.mockRejectedValue(new McpAuthRequired(null));
    const { server, tools } = collector();
    registerMcpServerTools(server, context, entry);
    const result = await tools[0].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Reconnect it on the Connectors page');
  });

  it('refuses without a subject rather than calling the server', async () => {
    const { server, tools } = collector();
    registerMcpServerTools(server, {} as MCPToolContext, entry);
    expect((await tools[0].handler({})).isError).toBe(true);
    expect(callRemoteTool).not.toHaveBeenCalled();
  });
});

describe('registeredNames', () => {
  it('keeps names unique when two tools collapse to the same one', () => {
    const names = [
      ...registeredNames('acme', [
        { name: 'a b', description: '', inputSchema: {}, readOnly: false },
        { name: 'a_b', description: '', inputSchema: {}, readOnly: false },
      ]).keys(),
    ];
    expect(new Set(names).size).toBe(2);
  });
});

describe('passthroughSchema', () => {
  it('advertises the server’s schema and defers validation to the server', () => {
    const schema = passthroughSchema({ type: 'object', properties: { q: { type: 'string' } } });
    const std = schema['~standard'];
    expect(std.jsonSchema.input({ target: 'draft-2020-12' })).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
    expect(std.validate({ anything: 1 })).toEqual({ value: { anything: 1 } });
    expect(std.validate('nope')).toHaveProperty('issues');
  });

  it('falls back to a plain object schema for one that is not an object', () => {
    const std = passthroughSchema({ type: 'string' })['~standard'];
    expect(std.jsonSchema.input({ target: 'draft-2020-12' })).toEqual({ type: 'object' });
  });
});
