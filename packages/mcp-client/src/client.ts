/**
 * A minimal MCP client for the app's own transport endpoint — stateless
 * Streamable HTTP, plain JSON-RPC over POST, bearer-authed with a token
 * minted for the caller. Nothing here knows it is talking to "itself"; it
 * is an ordinary MCP caller, which is the point: every gate the endpoint
 * applies to any client applies to an agent run and to a chat turn alike.
 *
 * mcp-handler may answer a POST as `application/json` or as a one-shot
 * `text/event-stream`; both are handled. A session id header, when the
 * server issues one, is echoed back on subsequent calls.
 */

/**
 * A widget's own declared purpose, from `_meta.ui.kind` (widgets.ts):
 * `'approval'` — the card carries a confirm/cancel decision (a preview
 * awaiting the user's send/create/discard); `'display'` — read-only,
 * nothing to confirm (a results list). Absent (older registration, or a
 * tool with no card at all) is not the same as either: a caller that needs
 * to know should treat missing as "unclassified", not "safe to skip
 * asking" — `'approval'` is the majority case and the safer assumption
 * when a card exists at all.
 */
export type WidgetKind = 'approval' | 'display';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The `ui://` widget resource this tool's result renders as, from
   * `_meta.ui.resourceUri` (MCP Apps / SEP-1865 — see widgets.ts). Absent
   * for a tool with no card.
   */
  uiResourceUri?: string;
  /** The card's own kind, from `_meta.ui.kind`. Present only alongside `uiResourceUri`. */
  uiKind?: WidgetKind;
}

export interface McpToolResult {
  content: { type: string; text?: string }[];
  isError: boolean;
  meta: Record<string, unknown>;
  /**
   * The widget's data payload (MCP Apps' `structuredContent`) — present
   * only for a call whose tool declares a `ui.resourceUri`. Opaque here;
   * each card template defines its own shape.
   */
  structuredContent?: unknown;
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
export function parseSseBody(body: string): unknown {
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

export interface HttpMcpClientOptions {
  /** How this caller introduces itself in `initialize`. */
  clientName?: string;
}

export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private readonly clientName: string;

  /**
   * The step attempt every subsequent call belongs to, stamped on each
   * request so a tool can tell it is being retried. Mutable and safe:
   * one client serves one run, and a run's attempts are strictly
   * sequential — concurrent runs each hold their own client.
   */
  private attempt: { attempt: number; maxAttempts: number } | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string,
    options: HttpMcpClientOptions = {}
  ) {
    this.clientName = options.clientName ?? 'renkei-agent-runner';
  }

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
        clientInfo: { name: this.clientName, version: '1.0.0' },
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
      const tool: {
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
        _meta?: unknown;
      } = entry;
      if (typeof tool.name !== 'string') return [];
      const uiResourceUri = widgetResourceUriOf(tool._meta);
      const uiKind = uiResourceUri ? widgetKindOf(tool._meta) : undefined;
      return [
        {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: plainObject(tool.inputSchema) ?? { type: 'object' },
          ...(uiResourceUri ? { uiResourceUri } : {}),
          ...(uiKind ? { uiKind } : {}),
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
    const shaped: {
      content?: unknown;
      isError?: unknown;
      _meta?: unknown;
      structuredContent?: unknown;
    } = typeof result === 'object' && result !== null ? result : {};
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
    return {
      content,
      isError: shaped.isError === true,
      meta: plainObject(shaped._meta) ?? {},
      ...('structuredContent' in shaped ? { structuredContent: shaped.structuredContent } : {}),
    };
  }
}

/** A JSON object or nothing — narrowed without an assertion. */
function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

/** `_meta.ui.resourceUri` off a tool's `tools/list` entry (widgets.ts's `previewToolMeta`). */
function widgetResourceUriOf(meta: unknown): string | undefined {
  const top = plainObject(meta);
  const ui = top ? plainObject(top.ui) : null;
  return typeof ui?.resourceUri === 'string' ? ui.resourceUri : undefined;
}

/** `_meta.ui.kind` off a tool's `tools/list` entry (widgets.ts's `previewToolMeta`). */
function widgetKindOf(meta: unknown): WidgetKind | undefined {
  const top = plainObject(meta);
  const ui = top ? plainObject(top.ui) : null;
  return ui?.kind === 'approval' || ui?.kind === 'display' ? ui.kind : undefined;
}
