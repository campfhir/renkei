/**
 * A client for a REMOTE MCP server, over either remote transport: Streamable
 * HTTP (one POST per JSON-RPC message, answered as JSON or a short event
 * stream) and the legacy HTTP+SSE transport (a long-lived GET stream that
 * announces a POST endpoint and carries every answer).
 *
 * It holds no credential. Every byte goes through the `McpFetch` it is
 * given, which in production is the delegate's authed fetch for the person's
 * grant on this server: the delegate attaches the bearer token, refreshes it,
 * and refuses any host but the server's own. A 401 surfaces as
 * `McpAuthRequired` so the caller can send the person to connect.
 *
 * A session is cheap and short-lived: opened for one listing or one call,
 * then closed. The server's own authorization is the only authorization.
 */

import {
  parseListedTool,
  resourceMetadataFromChallenge,
  type McpListedTool,
  type McpTransport,
} from './pure';

export type McpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_PAGES = 20;

/** The server wants a (new) access token. */
export class McpAuthRequired extends Error {
  constructor(readonly resourceMetadataUrl: string | null) {
    super('The MCP server requires authorization.');
    this.name = 'McpAuthRequired';
  }
}

/** The server or transport failed in a way that is not about authorization. */
export class McpRemoteError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
    this.name = 'McpRemoteError';
  }
}

export interface McpCallResult {
  content: { type: string; text?: string; [key: string]: unknown }[];
  isError: boolean;
  structuredContent?: unknown;
}

export interface McpRemoteSession {
  listTools(): Promise<McpListedTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  url: string;
  transport: McpTransport;
  fetch: McpFetch;
  timeoutMs?: number;
  clientName?: string;
}

interface SseEvent {
  event: string;
  data: string;
}

/** Events from an SSE body, as they complete. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, '\n');
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) break;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length > 0) yield { event, data: data.join('\n') };
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function isRpcResponse(value: unknown): value is RpcResponse {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRpcResponse(value) ? { ...value } : {};
}

function unwrap(response: RpcResponse): unknown {
  if (response.error) {
    const message =
      typeof response.error.message === 'string' ? response.error.message : 'MCP error';
    throw new McpRemoteError(
      message,
      typeof response.error.code === 'number' ? response.error.code : undefined
    );
  }
  return response.result;
}

function authHeaderFailure(response: Response): never {
  throw new McpAuthRequired(
    resourceMetadataFromChallenge(response.headers.get('www-authenticate'))
  );
}

abstract class BaseSession implements McpRemoteSession {
  protected nextId = 1;
  constructor(protected readonly options: OpenSessionOptions) {}

  protected get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  abstract request(method: string, params: Record<string, unknown>): Promise<unknown>;
  abstract notify(method: string): Promise<void>;
  abstract close(): Promise<void>;

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.options.clientName ?? 'renkei', version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpListedTool[]> {
    const tools: McpListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      const record = asRecord(result);
      const listed: unknown = record.tools;
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          const tool = parseListedTool(entry);
          if (tool) tools.push(tool);
        }
      }
      const next: unknown = record.nextCursor;
      if (typeof next !== 'string' || !next) break;
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    const record = asRecord(result);
    const content: McpCallResult['content'] = [];
    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        const entry = asRecord(block);
        if (typeof entry.type === 'string') content.push({ ...entry, type: entry.type });
      }
    }
    return {
      content,
      isError: record.isError === true,
      ...(record.structuredContent !== undefined
        ? { structuredContent: record.structuredContent }
        : {}),
    };
  }
}

class StreamableHttpSession extends BaseSession {
  private sessionId: string | null = null;

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    let response: Response;
    try {
      response = await this.options.fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new McpRemoteError(
        `Could not reach the MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (response.status === 401) authHeaderFailure(response);
    return response;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new McpRemoteError(`The MCP server answered ${response.status}. ${detail}`.trim());
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && response.body) {
      for await (const event of sseEvents(response.body)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (isRpcResponse(parsed) && parsed.id === id) return unwrap(parsed);
      }
      throw new McpRemoteError('The MCP server ended the stream without answering.');
    }
    const parsed: unknown = await response.json().catch(() => null);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const match = messages.find((m) => isRpcResponse(m) && m.id === id);
    if (!isRpcResponse(match)) throw new McpRemoteError('The MCP server sent no answer.');
    return unwrap(match);
  }

  async notify(method: string): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method });
    await response.body?.cancel().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const response = await this.options.fetch(this.options.url, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Best effort: the server expires idle sessions on its own.
    }
  }
}

class SseSession extends BaseSession {
  private readonly abort = new AbortController();
  private endpoint: string | null = null;
  private ready!: Promise<string>;
  private readonly waiting = new Map<number, (value: RpcResponse) => void>();
  private streamError: Error | null = null;

  async open(): Promise<void> {
    let response: Response;
    try {
      response = await this.options.fetch(this.options.url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION },
        signal: this.abort.signal,
      });
    } catch (error) {
      throw new McpRemoteError(
        `Could not reach the MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (response.status === 401) authHeaderFailure(response);
    if (!response.ok || !response.body) {
      throw new McpRemoteError(`The MCP server answered ${response.status} to the event stream.`);
    }
    const body = response.body;
    this.ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new McpRemoteError('The MCP server never announced a message endpoint.')),
        this.timeoutMs
      );
      void (async () => {
        try {
          for await (const event of sseEvents(body)) {
            if (event.event === 'endpoint') {
              clearTimeout(timer);
              this.endpoint = new URL(event.data.trim(), this.options.url).toString();
              resolve(this.endpoint);
            } else if (event.event === 'message') {
              let parsed: unknown;
              try {
                parsed = JSON.parse(event.data);
              } catch {
                continue;
              }
              if (isRpcResponse(parsed) && typeof parsed.id === 'number') {
                this.waiting.get(parsed.id)?.(parsed);
                this.waiting.delete(parsed.id);
              }
            }
          }
          this.streamError = new McpRemoteError('The MCP event stream closed.');
        } catch (error) {
          this.streamError = error instanceof Error ? error : new McpRemoteError(String(error));
        } finally {
          clearTimeout(timer);
          reject(this.streamError ?? new McpRemoteError('The MCP event stream closed.'));
        }
      })();
    });
    // The rejection above is observed by whoever awaits `ready`; one that
    // fires after a clean close must not surface as unhandled.
    this.ready.catch(() => undefined);
    await this.ready;
  }

  private async send(body: Record<string, unknown>): Promise<void> {
    const endpoint = this.endpoint ?? (await this.ready);
    if (new URL(endpoint).origin !== new URL(this.options.url).origin) {
      throw new McpRemoteError('The MCP server announced a message endpoint on another origin.');
    }
    let response: Response;
    try {
      response = await this.options.fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new McpRemoteError(
        `Could not reach the MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (response.status === 401) authHeaderFailure(response);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new McpRemoteError(`The MCP server answered ${response.status}.`);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const answer = new Promise<RpcResponse>((resolve, reject) => {
      this.waiting.set(id, resolve);
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new McpRemoteError(`${method} timed out.`));
      }, this.timeoutMs).unref();
    });
    answer.catch(() => undefined);
    await this.send({ jsonrpc: '2.0', id, method, params });
    return unwrap(await answer);
  }

  async notify(method: string): Promise<void> {
    await this.send({ jsonrpc: '2.0', method });
  }

  async close(): Promise<void> {
    this.abort.abort();
  }
}

/** An initialized session on a remote MCP server. Close it when done. */
export async function openMcpSession(options: OpenSessionOptions): Promise<McpRemoteSession> {
  const session =
    options.transport === 'sse' ? new SseSession(options) : new StreamableHttpSession(options);
  try {
    if (session instanceof SseSession) await session.open();
    await session.initialize();
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

/** One-shot helper: open, run, always close. */
export async function withMcpSession<T>(
  options: OpenSessionOptions,
  run: (session: McpRemoteSession) => Promise<T>
): Promise<T> {
  const session = await openMcpSession(options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}
