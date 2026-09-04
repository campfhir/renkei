/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The client's promises: JSON-RPC framing over POST with the bearer and
 * protocol headers, tolerance for both answer shapes the endpoint uses
 * (JSON and one-shot SSE), the session id echoed once issued, and tool
 * results shaped defensively.
 */

import { HttpMcpClient, parseSseBody } from './client';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('parseSseBody', () => {
  it('returns the last complete data frame', () => {
    expect(parseSseBody('data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"broken\n')).toEqual({ a: 2 });
  });
});

describe('HttpMcpClient', () => {
  it('initializes with the configured client name and echoes the session id', async () => {
    const client = new HttpMcpClient('http://app/api/mcp/t/mcp', 'tok', {
      clientName: 'renkei-chat',
    });
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'sess-1' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    await client.initialize();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['mcp-protocol-version']).toBeDefined();
    expect(JSON.parse(String(init.body)).params.clientInfo.name).toBe('renkei-chat');

    const [, second] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect((second.headers as Record<string, string>)['mcp-session-id']).toBe('sess-1');
  });

  it('lists tools from a one-shot SSE answer, defaulting a missing schema', async () => {
    const client = new HttpMcpClient('http://app/api/mcp/t/mcp', 'tok');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              { name: 'whoami', description: 'Who am I', inputSchema: { type: 'object' } },
              { name: 'odd', inputSchema: 'nope' },
              { notAName: true },
            ],
          },
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    );
    expect(await client.listTools()).toEqual([
      { name: 'whoami', description: 'Who am I', inputSchema: { type: 'object' } },
      { name: 'odd', description: '', inputSchema: { type: 'object' } },
    ]);
  });

  it('shapes a tool result and surfaces a JSON-RPC error as a thrown Error', async () => {
    const client = new HttpMcpClient('http://app/api/mcp/t/mcp', 'tok');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: 'hi' }, { type: 'image' }, 'junk'],
          isError: false,
          _meta: { 'renkei/outcome': 'ok' },
        },
      })
    );
    expect(await client.callTool('whoami', {})).toEqual({
      content: [{ type: 'text', text: 'hi' }, { type: 'image' }],
      isError: false,
      meta: { 'renkei/outcome': 'ok' },
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'no such tool' } })
    );
    await expect(client.callTool('nope', {})).rejects.toThrow('no such tool');
  });

  it('throws on a non-2xx from the endpoint', async () => {
    const client = new HttpMcpClient('http://app/api/mcp/t/mcp', 'tok');
    fetchSpy.mockResolvedValueOnce(new Response('denied', { status: 401 }));
    await expect(client.listTools()).rejects.toThrow('MCP endpoint 401');
  });
});
