/**
 * Widget-side MCP Apps bridge (SEP-1865, extension revision 2026-01-26).
 *
 * A preview card runs inside the host's sandboxed iframe and speaks JSON-RPC
 * 2.0 to the host over postMessage: `ui/initialize` handshake first, then the
 * host streams the originating tool call's arguments and result in
 * (`ui/notifications/tool-input` / `tool-result`), and the card calls back
 * through the host with `tools/call` — that is how its Send button reaches
 * the app-only confirm tools. This is deliberately a minimal hand-rolled
 * client rather than a dependency: the protocol surface a preview card needs
 * is five methods, and the bundle ships inline inside a `ui://` resource
 * where every kilobyte is weight the MCP response carries.
 */

type Json = Record<string, unknown>;

export interface HostContext {
  theme?: 'light' | 'dark';
  styles?: { variables?: Record<string, string>; css?: { fonts?: string } };
  [key: string]: unknown;
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

/** First text block of a tool result — the human-readable error when isError. */
export function resultText(result: ToolResult): string {
  const block = (result.content ?? []).find((entry) => entry.type === 'text');
  return block?.text ?? '';
}

export class WidgetBridge {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private onToolResult: Array<(result: ToolResult) => void> = [];
  private onToolInput: Array<(args: Json) => void> = [];
  hostContext: HostContext = {};

  constructor(private appName: string) {
    window.addEventListener('message', (event: MessageEvent) => this.receive(event));
  }

  /** Handshake; resolves once the host has answered `ui/initialize`. */
  async connect(): Promise<void> {
    const result = await this.request('ui/initialize', {
      appInfo: { name: this.appName, version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26',
    });
    this.hostContext = asRecord(result.hostContext);
    applyHostContext(this.hostContext);
    this.notify('ui/notifications/initialized', {});
    this.watchSize();
  }

  toolResult(handler: (result: ToolResult) => void): void {
    this.onToolResult.push(handler);
  }

  toolInput(handler: (args: Json) => void): void {
    this.onToolInput.push(handler);
  }

  /** Call a tool on the MCP server, through the host. */
  async callTool(name: string, args: Json): Promise<ToolResult> {
    return this.request('tools/call', { name, arguments: args });
  }

  /** Open an external URL through the host (new tab / system browser). */
  openLink(url: string): void {
    this.request('ui/open-link', { url }).catch(() => {
      // Host refused or predates ui/open-link — a direct open is the only
      // fallback, and a sandbox without allow-popups just no-ops it.
      window.open(url, '_blank', 'noopener');
    });
  }

  /**
   * Tell the model what the user did in the card. Without this the
   * conversation's record stops at "a preview was shown" — the send or the
   * discard happened outside the model's view, and its next reply would
   * guess. Best-effort: a host that rejects it loses nothing but fidelity.
   */
  updateModelContext(text: string): void {
    this.request('ui/update-model-context', {
      content: [{ type: 'text', text }],
    }).catch(() => undefined);
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    const promise = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return promise;
  }

  private notify(method: string, params: Json): void {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  private respond(id: unknown, result: Json): void {
    window.parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
  }

  private receive(event: MessageEvent): void {
    const message = asRecord(event.data);
    if (message.jsonrpc !== '2.0') return;

    // A response to one of our requests.
    if (message.id !== undefined && !('method' in message)) {
      const waiting = this.pending.get(Number(message.id));
      if (!waiting) return;
      this.pending.delete(Number(message.id));
      if ('error' in message) {
        const error = asRecord(message.error);
        waiting.reject(new Error(typeof error.message === 'string' ? error.message : 'Host error'));
      } else {
        waiting.resolve(asRecord(message.result));
      }
      return;
    }

    const params = asRecord(message.params);
    switch (message.method) {
      case 'ui/notifications/tool-input':
        this.onToolInput.forEach((handler) => handler(asRecord(params.arguments)));
        break;
      case 'ui/notifications/tool-result':
        // Params ARE the CallToolResult.
        this.onToolResult.forEach((handler) => handler(params));
        break;
      case 'ui/notifications/host-context-changed':
        this.hostContext = { ...this.hostContext, ...params };
        applyHostContext(this.hostContext);
        break;
      case 'ping':
        if (message.id !== undefined) this.respond(message.id, {});
        break;
      case 'ui/resource-teardown':
        if (message.id !== undefined) this.respond(message.id, {});
        break;
    }
  }

  /**
   * Report content height so the host sizes the iframe to the card.
   *
   * Measured on BODY, not documentElement. In an iframe
   * `documentElement.scrollHeight` is at least the viewport height, and the
   * viewport is whatever the host last sized the frame to — so once a tall
   * card had been rendered the number could never come back down. Replacing
   * a form with a two-line receipt left the frame at its old height and the
   * card became a small message floating in a large blank box.
   *
   * `body` is a plain block that wraps its content, so its border-box
   * height shrinks with it.
   */
  private watchSize(): void {
    let last = -1;
    const report = () => {
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      // The host resizing the frame resizes the body's containing block,
      // which fires the observer again. Reporting only real changes stops
      // that from becoming a loop.
      if (height === last) return;
      last = height;
      this.notify('ui/notifications/size-changed', { height });
    };
    new ResizeObserver(report).observe(document.body);
    report();
  }
}

function asRecord(value: unknown): Json {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

/** Host theme + style variables onto the document, re-applied on change. */
function applyHostContext(context: HostContext): void {
  if (context.theme === 'dark' || context.theme === 'light') {
    document.documentElement.dataset.theme = context.theme;
  }
  const variables = context.styles?.variables ?? {};
  for (const [key, value] of Object.entries(variables)) {
    if (key.startsWith('--') && typeof value === 'string') {
      document.documentElement.style.setProperty(key, value);
    }
  }
}
