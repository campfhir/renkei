/**
 * A minimal MCP client for the app's own transport endpoint — stateless
 * Streamable HTTP, plain JSON-RPC over POST, bearer-authed with a run
 * token. Nothing here knows it is talking to "itself"; it is an ordinary
 * MCP caller, which is the point: every gate the endpoint applies to any
 * client applies to an agent run.
 *
 * mcp-handler may answer a POST as `application/json` or as a one-shot
 * `text/event-stream`; both are handled. A session id header, when the
 * server issues one, is echoed back on subsequent calls.
 */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: { type: string; text?: string }[];
  isError: boolean;
  meta: Record<string, unknown>;
}

export interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
  /**
   * Tell the server which try of a step the next calls belong to. Optional
   * so the in-memory test doubles need not implement it.
   */
  setAttempt?(attempt: number, maxAttempts: number): void;
}

const CALL_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** The last complete JSON-RPC message in a one-shot SSE body. */
function parseSseBody(body: string): unknown {
  let last: unknown;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      last = JSON.parse(payload);
    } catch {
      // Partial frame; keep the previous complete one.
    }
  }
  return last;
}

export class AgentMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | null = null;

  /**
   * The step attempt every subsequent call belongs to, stamped on each
   * request so a tool can tell it is being retried. Mutable and safe:
   * one client serves one run, and a run's attempts are strictly
   * sequential — concurrent runs each hold their own client.
   */
  private attempt: { attempt: number; maxAttempts: number } | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string
  ) {}

  /** Called by the engine before each attempt of a step. */
  setAttempt(attempt: number, maxAttempts: number): void {
    this.attempt = { attempt, maxAttempts };
  }

  private async post(body: unknown, timeoutMs: number): Promise<unknown> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.bearerToken}`,
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.attempt
          ? {
              'x-renkei-attempt': String(this.attempt.attempt),
              'x-renkei-attempt-max': String(this.attempt.maxAttempts),
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    // Notifications are fire-and-forget; 202 carries no body.
    if (response.status === 202) return undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MCP endpoint ${response.status}: ${text.slice(0, 300)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return parseSseBody(await response.text());
    }
    return response.json();
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const id = this.nextId++;
    const raw = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`MCP ${method}: empty or malformed response`);
    }
    const message: JsonRpcResponse = raw;
    if (message.error) {
      throw new Error(
        `MCP ${method} failed: ${typeof message.error.message === 'string' ? message.error.message : 'unknown error'}`
      );
    }
    return message.result;
  }

  async initialize(): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'renkei-agent-runner', version: '1.0.0' },
      },
      CALL_TIMEOUT_MS
    );
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, CALL_TIMEOUT_MS);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request('tools/list', {}, CALL_TIMEOUT_MS);
    const shaped: { tools?: unknown } = typeof result === 'object' && result !== null ? result : {};
    const tools: unknown[] = Array.isArray(shaped.tools) ? shaped.tools : [];
    return tools.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const tool: { name?: unknown; description?: unknown; inputSchema?: unknown } = entry;
      if (typeof tool.name !== 'string') return [];
      return [
        {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema:
            typeof tool.inputSchema === 'object' &&
            tool.inputSchema !== null &&
            !Array.isArray(tool.inputSchema)
              ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
                (tool.inputSchema as Record<string, unknown>)
              : { type: 'object' },
        },
      ];
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const shaped: { content?: unknown; isError?: unknown; _meta?: unknown } =
      typeof result === 'object' && result !== null ? result : {};
    const content = Array.isArray(shaped.content)
      ? shaped.content.flatMap((block: unknown) => {
          if (typeof block !== 'object' || block === null) return [];
          const entry: { type?: unknown; text?: unknown } = block;
          if (typeof entry.type !== 'string') return [];
          return [
            { type: entry.type, ...(typeof entry.text === 'string' ? { text: entry.text } : {}) },
          ];
        })
      : [];
    const meta =
      typeof shaped._meta === 'object' && shaped._meta !== null && !Array.isArray(shaped._meta)
        ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
          (shaped._meta as Record<string, unknown>)
        : {};
    return { content, isError: shaped.isError === true, meta };
  }
}
