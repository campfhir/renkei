import { McpAuthRequired, watchToolListChanges, withMcpSession, type McpFetch } from './client';

function sse(...events: { event?: string; data: string }[]): Response {
  const text = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${e.data}\n\n`)
    .join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('streamable HTTP', () => {
  it('initializes, lists tools across pages, and calls one', async () => {
    const seen: string[] = [];
    const fetchImpl: McpFetch = async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const body = JSON.parse(String(init?.body));
      seen.push(body.method);
      const session = new Headers(init?.headers).get('mcp-session-id');
      switch (body.method) {
        case 'initialize':
          return json({ jsonrpc: '2.0', id: body.id, result: {} }, { 'mcp-session-id': 's1' });
        case 'notifications/initialized':
          return new Response(null, { status: 202 });
        case 'tools/list':
          expect(session).toBe('s1');
          return body.params.cursor
            ? json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'two' }] } })
            : sse({
                data: JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: { tools: [{ name: 'one' }], nextCursor: 'c' },
                }),
              });
        default:
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: 'hi' }], isError: false },
          });
      }
    };
    const result = await withMcpSession(
      { url: 'https://m.example/mcp', transport: 'streamable_http', fetch: fetchImpl },
      async (session) => ({
        tools: await session.listTools(),
        call: await session.callTool('one', { a: 1 }),
      })
    );
    expect(result.tools.map((t) => t.name)).toEqual(['one', 'two']);
    expect(result.call.content[0].text).toBe('hi');
    expect(seen).toContain('notifications/initialized');
  });

  it('raises McpAuthRequired with the resource metadata URL on 401', async () => {
    const fetchImpl: McpFetch = async () =>
      new Response('no', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://m.example/rm"' },
      });
    await expect(
      withMcpSession(
        { url: 'https://m.example/mcp', transport: 'streamable_http', fetch: fetchImpl },
        async () => 1
      )
    ).rejects.toMatchObject({
      name: 'McpAuthRequired',
      resourceMetadataUrl: 'https://m.example/rm',
    });
    expect(new McpAuthRequired(null).message).toMatch(/authorization/);
  });
});

describe('legacy SSE', () => {
  it('reads the endpoint event and receives answers on the stream', async () => {
    let push: (chunk: string) => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        push('event: endpoint\ndata: /messages?sid=1\n\n');
      },
    });
    const fetchImpl: McpFetch = async (url, init) => {
      if (init?.method === 'GET') {
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      expect(url).toBe('https://m.example/messages?sid=1');
      const body = JSON.parse(String(init?.body));
      if (body.id !== undefined) {
        const result = body.method === 'tools/list' ? { tools: [{ name: 'legacy' }] } : {};
        push(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`
        );
      }
      return new Response('Accepted', { status: 202 });
    };
    const tools = await withMcpSession(
      { url: 'https://m.example/sse', transport: 'sse', fetch: fetchImpl },
      (session) => session.listTools()
    );
    expect(tools.map((t) => t.name)).toEqual(['legacy']);
  });
});

describe('watchToolListChanges', () => {
  const initialize = (listChanged: boolean) => (body: { id: number }) =>
    json(
      { jsonrpc: '2.0', id: body.id, result: { capabilities: { tools: { listChanged } } } },
      { 'mcp-session-id': 's1' }
    );

  it('calls onChange for each list_changed on the server’s stream, then reports the stream ended', async () => {
    const fetchImpl: McpFetch = async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (init?.method === 'GET') {
        expect(new Headers(init.headers).get('mcp-session-id')).toBe('s1');
        return sse(
          { data: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) },
          { data: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message' }) },
          { data: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) }
        );
      }
      const body = JSON.parse(String(init?.body));
      return body.method === 'initialize'
        ? initialize(true)(body)
        : new Response(null, { status: 202 });
    };
    let changes = 0;
    const outcome = await watchToolListChanges({
      url: 'https://m.example/mcp',
      transport: 'streamable_http',
      fetch: fetchImpl,
      signal: new AbortController().signal,
      onChange: () => (changes += 1),
    });
    expect(outcome).toBe('ended');
    expect(changes).toBe(2);
  });

  it('is unsupported when the server does not advertise listChanged, and opens no stream', async () => {
    const methods: string[] = [];
    const fetchImpl: McpFetch = async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const body = JSON.parse(String(init?.body));
      return body.method === 'initialize'
        ? initialize(false)(body)
        : new Response(null, { status: 202 });
    };
    const outcome = await watchToolListChanges({
      url: 'https://m.example/mcp',
      transport: 'streamable_http',
      fetch: fetchImpl,
      signal: new AbortController().signal,
      onChange: () => undefined,
    });
    expect(outcome).toBe('unsupported');
    expect(methods).not.toContain('GET');
  });

  it('is unsupported when the server advertises it but offers no stream (405)', async () => {
    const fetchImpl: McpFetch = async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body));
      return body.method === 'initialize'
        ? initialize(true)(body)
        : new Response(null, { status: 202 });
    };
    const outcome = await watchToolListChanges({
      url: 'https://m.example/mcp',
      transport: 'streamable_http',
      fetch: fetchImpl,
      signal: new AbortController().signal,
      onChange: () => undefined,
    });
    expect(outcome).toBe('unsupported');
  });

  it('hears list_changed on the legacy SSE stream', async () => {
    let push: (chunk: string) => void = () => undefined;
    let end: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        end = () => controller.close();
        push('event: endpoint\ndata: /messages?sid=1\n\n');
      },
    });
    const fetchImpl: McpFetch = async (_url, init) => {
      if (init?.method === 'GET') {
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      const body = JSON.parse(String(init?.body));
      if (body.id !== undefined) {
        const result = { capabilities: { tools: { listChanged: true } } };
        push(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`
        );
      }
      return new Response('Accepted', { status: 202 });
    };
    let changes = 0;
    const watching = watchToolListChanges({
      url: 'https://m.example/sse',
      transport: 'sse',
      fetch: fetchImpl,
      signal: new AbortController().signal,
      onChange: () => (changes += 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    push(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    end();
    expect(await watching).toBe('ended');
    expect(changes).toBe(1);
  });
});
