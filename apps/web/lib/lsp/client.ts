/**
 * The editor's side of a language server session: JSON-RPC over two
 * routes. Messages to the server go by POST to `…/lsp/<session>`, one
 * at a time in the order they were made (a `didChange` must land before
 * the completion asked on it); the server's messages come back on one
 * `EventSource` from the same address, one message per event, which the
 * browser reconnects on its own — and the worker keeps what the server
 * said in the meantime, so a reconnect misses nothing.
 *
 * Requests are correlated by id and can be cancelled (Monaco cancels a
 * completion the moment the next keystroke lands; the server is told
 * with `$/cancelRequest`). A server's own request to the editor is
 * answered by a registered handler, or with "method not found" so the
 * server is never left waiting. When the server exits, the worker says
 * so as a notification of its own (`$/renkei/exited`) and this client
 * settles everything pending and tells whoever asked to know.
 */

import type { LspServerCapabilities } from './protocol';

export interface Cancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class LspRequestError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'LspRequestError';
  }
}

export class LspCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'LspCancelled';
  }
}

export type LspExitInfo = { code: number | null; signal: string | null; stderr: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export interface LspClientOptions {
  /** `…/code/projects/<id>/lsp/<session>`. */
  url: string;
  server: string;
  rootUri: string;
  capabilities: LspServerCapabilities;
}

export class LspClient {
  readonly server: string;
  readonly rootUri: string;
  readonly capabilities: LspServerCapabilities;
  private readonly url: string;
  private source: EventSource | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private readonly exitHandlers = new Set<(info: LspExitInfo) => void>();
  private readonly stateHandlers = new Set<(state: LspClientState) => void>();
  private outbound: Promise<void> = Promise.resolve();
  private state: LspClientState = 'connecting';
  private disposed = false;

  constructor(options: LspClientOptions) {
    this.url = options.url;
    this.server = options.server;
    this.rootUri = options.rootUri;
    this.capabilities = options.capabilities;
  }

  get connectionState(): LspClientState {
    return this.state;
  }

  connect(): void {
    if (this.source || this.disposed) return;
    const source = new EventSource(this.url);
    this.source = source;
    source.onopen = () => this.setState('ready');
    source.onerror = () => {
      if (this.disposed) return;
      // The browser reconnects on its own; the worker holds the backlog.
      this.setState(source.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
    };
    source.onmessage = (event: MessageEvent<string>) => {
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatch(message);
    };
  }

  onStateChange(listener: (state: LspClientState) => void): () => void {
    this.stateHandlers.add(listener);
    return () => this.stateHandlers.delete(listener);
  }

  private setState(state: LspClientState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateHandlers) listener(state);
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message)) return;
    const { id, params, result } = message;
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (method === undefined) {
      // A response to one of ours.
      if (typeof id !== 'number') return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = isRecord(message.error) ? message.error : null;
      if (error) {
        pending.reject(
          new LspRequestError(
            typeof error.code === 'number' ? error.code : -32000,
            typeof error.message === 'string' ? error.message : 'The server refused.',
            error.data
          )
        );
      } else {
        pending.resolve(result);
      }
      return;
    }
    if (method === '$/renkei/exited') {
      const info = isRecord(params) ? params : {};
      this.settleAll(new LspRequestError(-32000, 'The language server exited.'));
      this.setState('exited');
      for (const listener of this.exitHandlers) {
        listener({
          code: typeof info.code === 'number' ? info.code : null,
          signal: typeof info.signal === 'string' ? info.signal : null,
          stderr: typeof info.stderr === 'string' ? info.stderr : '',
        });
      }
      return;
    }
    if (id !== undefined && id !== null) {
      // The server asks the editor something.
      const handler = this.requestHandlers.get(method);
      if (!handler) {
        this.post({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `${method} is not handled by the editor.` },
        });
        return;
      }
      void Promise.resolve()
        .then(() => handler(params))
        .then(
          (value) => this.post({ jsonrpc: '2.0', id, result: value ?? null }),
          (failure: unknown) =>
            this.post({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message: failure instanceof Error ? failure.message : String(failure),
              },
            })
        );
      return;
    }
    const handlers = this.notificationHandlers.get(method);
    if (handlers) for (const handler of handlers) handler(params);
  }

  /** Everything in the queue and in flight, in order. */
  private post(message: Record<string, unknown>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const body = JSON.stringify(message);
    const send = async () => {
      if (this.disposed) return;
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (response.ok) {
          // A 202 has no body; reading it anyway closes the request cleanly
          // rather than leaving the browser to abort an unread stream.
          await response.text().catch(() => '');
        }
        if (response.status === 404 || response.status === 409) {
          // The session is gone from the worker: nothing else will land either.
          const said = await response.json().catch(() => null);
          const detail =
            typeof said?.error === 'string' ? said.error : 'The language server session is gone.';
          this.settleAll(new LspRequestError(-32000, detail));
          this.setState('exited');
          for (const listener of this.exitHandlers)
            listener({ code: null, signal: null, stderr: detail });
        }
      } catch {
        // A network blip: the next message tries again; a request left
        // pending is settled when the server's exit is heard or on dispose.
      }
    };
    this.outbound = this.outbound.then(send, send);
    return this.outbound;
  }

  notify(method: string, params: unknown): void {
    void this.post({ jsonrpc: '2.0', method, params });
  }

  request<T>(method: string, params: unknown, cancellation?: Cancellation): Promise<T> {
    if (this.disposed || this.state === 'exited') {
      return Promise.reject(new LspRequestError(-32000, 'The language server is gone.'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (cancellation?.isCancellationRequested) {
        reject(new LspCancelled());
        return;
      }
      const subscription = cancellation?.onCancellationRequested(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.notify('$/cancelRequest', { id });
        reject(new LspCancelled());
      });
      this.pending.set(id, {
        resolve: (value) => {
          subscription?.dispose();
          // The one place the wire's answer takes the shape the caller asked for.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          resolve(value as T);
        },
        reject: (error) => {
          subscription?.dispose();
          reject(error);
        },
      });
      void this.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  onRequest(method: string, handler: (params: unknown) => unknown): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  onExit(handler: (info: LspExitInfo) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  private settleAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** Close the stream and the server; nothing pending survives. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source?.close();
    this.source = null;
    this.settleAll(new LspRequestError(-32000, 'The editor closed the language server.'));
    this.setState('closed');
    // Fire and forget, and allowed to outlive the page (a tab closing).
    void fetch(this.url, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
}

export type LspClientState = 'connecting' | 'ready' | 'exited' | 'closed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
