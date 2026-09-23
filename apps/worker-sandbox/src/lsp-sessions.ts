/**
 * Language server sessions — one server process per (checkout, server,
 * editor), started the way every other process in a checkout is (as
 * the caller's own uid, in the checkout, with an environment built from
 * nothing), spoken to over stdio in the protocol's `Content-Length`
 * framing, and relayed to the browser's editor by the `lsp/*` verbs in
 * workspace-endpoints.ts.
 *
 * The worker is the process's owner, the browser its client. So the
 * worker runs `initialize`/`initialized` itself, rooted at the checkout
 * and nowhere else, keeps the server's capabilities to hand the editor,
 * answers the few server→client requests that are about this process
 * rather than the editor (configuration, capability registration,
 * progress tokens, the workspace folder), and shuts the server down on
 * close, on idleness, and when this process exits. Everything else the
 * server says is queued for the editor: buffered while no events stream
 * is attached (a reconnecting browser), streamed as it comes otherwise,
 * every string scrubbed of the caller's environment values like every
 * other text this worker returns.
 *
 * A session is named by a random id and remembered with its owner's
 * (tenantId, subject); a verb that names a session of another owner is
 * told there is no such session, the same rule as workspaces.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants as fsConstants } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LANGUAGE_SERVERS,
  LSP_BUFFER_MAX_MESSAGES,
  LSP_IDLE_MS,
  LSP_INIT_TIMEOUT_MS,
  LSP_MAX_SESSIONS,
  LSP_MAX_SESSIONS_PER_WORKSPACE,
  LSP_MESSAGE_MAX_BYTES,
  languageServerSpec,
  serverArgs,
  type JsonRpcMessage,
  type LanguageServerId,
} from '@renkei/connector-sandbox';
import {
  childEnvironment,
  shellPrelude,
  wrapCommand,
  type ExecIdentity,
  type RunInput,
} from './workspaces';
import { logger } from './logger';

const COMPONENT = 'worker-sandbox/lsp';
const REAP_INTERVAL_MS = 30_000;
const SHUTDOWN_GRACE_MS = 3_000;
/** The directories a caller's PATH names, for the boot probe (childEnvironment builds the same). */
const PROBE_PATH = childEnvironment({
  cwd: '/',
  home: '/nonexistent',
  identity: null,
  env: {},
  timeoutMs: 0,
})
  .PATH.split(':')
  .filter((dir) => !dir.startsWith('/nonexistent'));

export interface LspOwner {
  tenantId: string;
  subject: string;
}

export interface OpenSessionInput {
  owner: LspOwner;
  workspaceId: string;
  /** The checkout's directory on disk — the server's root and working directory. */
  rootDir: string;
  home: string;
  identity: ExecIdentity | null;
  server: LanguageServerId;
  /** The editor's own id, so two tabs of one chat each get their own server. */
  clientId: string;
}

export type OpenOutcome =
  | { ok: true; session: SessionView; reused: boolean }
  | { ok: false; status: number; type: string; message: string };

export interface SessionView {
  id: string;
  server: LanguageServerId;
  workspaceId: string;
  rootUri: string;
  /** The server's `initialize` result capabilities, verbatim. */
  capabilities: unknown;
  serverInfo: unknown;
}

type Listener = (message: string) => void;

interface Session {
  id: string;
  owner: LspOwner;
  workspaceId: string;
  clientId: string;
  server: LanguageServerId;
  rootUri: string;
  child: ChildProcess;
  state: 'starting' | 'ready' | 'exited';
  exit: { code: number | null; signal: string | null } | null;
  capabilities: unknown;
  serverInfo: unknown;
  /** Messages for the editor while no listener is attached. */
  buffer: string[];
  listener: Listener | null;
  lastActivity: number;
  /** Requests this worker made (initialize, shutdown) awaiting their response, as the wire had it. */
  pending: Map<string, (response: Record<string, unknown>) => void>;
  nextId: number;
  /** The server's stderr tail, for the log when it dies. */
  stderrTail: string;
}

/** Parse the protocol's `Content-Length: N\r\n\r\n<body>` framing off a byte stream. */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  /** Feed bytes; answers every complete body they finish, or throws when a frame is oversized. */
  push(chunk: Buffer): string[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const bodies: string[] = [];
    for (;;) {
      const headerEnd = this.pending.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (this.pending.length > 16_384) throw new Error('A frame header is too long.');
        break;
      }
      const header = this.pending.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error('A frame has no Content-Length.');
      const length = Number(match[1]);
      if (length > this.maxBytes) throw new Error(`A frame of ${length} bytes is over the limit.`);
      const bodyStart = headerEnd + 4;
      if (this.pending.length < bodyStart + length) break;
      bodies.push(this.pending.subarray(bodyStart, bodyStart + length).toString('utf8'));
      this.pending = this.pending.subarray(bodyStart + length);
    }
    return bodies;
  }
}

export function frame(body: string): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${bytes.byteLength}\r\n\r\n`, 'ascii'),
    bytes,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Which of the registry's servers this worker can start: the command is
 * on the PATH a caller's process gets. Probed once; the image does not
 * change under a running worker.
 */
let availableServers: Promise<LanguageServerId[]> | null = null;

export function probeLanguageServers(): Promise<LanguageServerId[]> {
  if (!availableServers) {
    availableServers = (async () => {
      const found: LanguageServerId[] = [];
      for (const spec of LANGUAGE_SERVERS) {
        for (const dir of PROBE_PATH) {
          try {
            await access(join(dir, spec.command), fsConstants.X_OK);
            found.push(spec.id);
            break;
          } catch {
            // Not here; the next directory.
          }
        }
      }
      return found;
    })();
  }
  return availableServers;
}

/** Test-only: forget the probe so a test can put a server on the PATH. */
export function resetLanguageServerProbeForTests(): void {
  availableServers = null;
}

/**
 * What the worker tells a server the editor can do. Broad enough that a
 * server offers its full protocol (the editor decides what to use), and
 * honest about the two things the client is not: it applies no
 * workspace edits and holds no configuration.
 */
export function clientCapabilities(): Record<string, unknown> {
  return {
    workspace: {
      applyEdit: false,
      workspaceEdit: { documentChanges: false },
      configuration: true,
      // One checkout is one root: `rootUri` says it, and a client that
      // announces multi-root support gets a different start-up from some
      // servers (Pyright waits on it and never analyses a file).
      workspaceFolders: false,
      didChangeConfiguration: { dynamicRegistration: false },
      didChangeWatchedFiles: { dynamicRegistration: false },
      symbol: { dynamicRegistration: false },
      semanticTokens: { refreshSupport: false },
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
      publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
      completion: {
        dynamicRegistration: false,
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: false,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
          insertReplaceSupport: true,
          resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
        },
        completionItemKind: { valueSet: Array.from({ length: 25 }, (_, index) => index + 1) },
      },
      hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
      signatureHelp: {
        dynamicRegistration: false,
        signatureInformation: {
          documentationFormat: ['markdown', 'plaintext'],
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
        contextSupport: true,
      },
      definition: { dynamicRegistration: false, linkSupport: true },
      typeDefinition: { dynamicRegistration: false, linkSupport: true },
      implementation: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false },
      documentHighlight: { dynamicRegistration: false },
      documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      formatting: { dynamicRegistration: false },
      rangeFormatting: { dynamicRegistration: false },
      rename: { dynamicRegistration: false, prepareSupport: true },
      codeAction: { dynamicRegistration: false },
      semanticTokens: {
        dynamicRegistration: false,
        requests: { range: false, full: { delta: false } },
        tokenTypes: SEMANTIC_TOKEN_TYPES,
        tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
        formats: ['relative'],
        overlappingTokenSupport: false,
        multilineTokenSupport: false,
      },
      inlayHint: { dynamicRegistration: false },
    },
    window: { workDoneProgress: true, showMessage: {}, showDocument: { support: false } },
    general: { positionEncodings: ['utf-16'] },
  };
}

const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
];

export interface LspSessionsDeps {
  /** Test-only: a different spawn (a scripted server). */
  spawnServer?: (input: OpenSessionInput, sessionId: string) => ChildProcess;
}

export class LspSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly reaper: NodeJS.Timeout;

  constructor(private readonly deps: LspSessionsDeps = {}) {
    this.reaper = setInterval(() => void this.reapIdle(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  count(): number {
    return this.sessions.size;
  }

  /** The session by id, when it is the caller's; otherwise nothing, whoever's it is. */
  private owned(id: string, owner: LspOwner): Session | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.owner.tenantId !== owner.tenantId || session.owner.subject !== owner.subject) {
      return null;
    }
    return session;
  }

  view(session: Session): SessionView {
    return {
      id: session.id,
      server: session.server,
      workspaceId: session.workspaceId,
      rootUri: session.rootUri,
      capabilities: session.capabilities,
      serverInfo: session.serverInfo,
    };
  }

  /**
   * Start a server for the editor, or hand back the one it already has
   * for this checkout and language (a reload of the page comes back with
   * the same client id and finds its server still there).
   */
  async open(input: OpenSessionInput): Promise<OpenOutcome> {
    const existing = [...this.sessions.values()].find(
      (session) =>
        session.owner.tenantId === input.owner.tenantId &&
        session.owner.subject === input.owner.subject &&
        session.workspaceId === input.workspaceId &&
        session.server === input.server &&
        session.clientId === input.clientId &&
        session.state === 'ready'
    );
    if (existing) {
      existing.lastActivity = Date.now();
      return { ok: true, session: this.view(existing), reused: true };
    }
    const available = await probeLanguageServers();
    if (!this.deps.spawnServer && !available.includes(input.server)) {
      return {
        ok: false,
        status: 404,
        type: 'server_unavailable',
        message: `This worker has no ${languageServerSpec(input.server).label} language server.`,
      };
    }
    const inWorkspace = [...this.sessions.values()].filter(
      (session) => session.workspaceId === input.workspaceId
    ).length;
    if (inWorkspace >= LSP_MAX_SESSIONS_PER_WORKSPACE) {
      return {
        ok: false,
        status: 429,
        type: 'session_limit',
        message: `At most ${LSP_MAX_SESSIONS_PER_WORKSPACE} language servers per checkout at once; close an editor.`,
      };
    }
    if (this.sessions.size >= LSP_MAX_SESSIONS) {
      return {
        ok: false,
        status: 429,
        type: 'session_limit',
        message: 'This worker is running as many language servers as it will; try again shortly.',
      };
    }

    const id = randomUUID();
    let child: ChildProcess;
    try {
      child = this.deps.spawnServer ? this.deps.spawnServer(input, id) : spawnServer(input, id);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        type: 'spawn_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const session: Session = {
      id,
      owner: input.owner,
      workspaceId: input.workspaceId,
      clientId: input.clientId,
      server: input.server,
      rootUri: pathToFileURL(input.rootDir).href.replace(/\/$/, ''),
      child,
      state: 'starting',
      exit: null,
      capabilities: null,
      serverInfo: null,
      buffer: [],
      listener: null,
      lastActivity: Date.now(),
      pending: new Map(),
      nextId: 1,
      stderrTail: '',
    };
    this.sessions.set(id, session);
    this.attach(session);

    const initialized = await this.initialize(session);
    if (!initialized.ok) {
      this.kill(session, 'SIGKILL');
      this.sessions.delete(id);
      return { ok: false, status: 502, type: 'server_failed', message: initialized.message };
    }
    session.state = 'ready';
    logger.info('language server {server} started for workspace {workspaceId} ({session})', {
      component: COMPONENT,
      server: input.server,
      workspaceId: input.workspaceId,
      session: id,
    });
    return { ok: true, session: this.view(session), reused: false };
  }

  /** Wire the child's streams: frames in, their messages routed; stderr kept; exit noted. */
  private attach(session: Session): void {
    const reader = new FrameReader(LSP_MESSAGE_MAX_BYTES);
    session.child.stdout?.on('data', (chunk: Buffer) => {
      let bodies: string[];
      try {
        bodies = reader.push(chunk);
      } catch (error) {
        logger.warn('language server {session} sent an unreadable frame: {error}', {
          component: COMPONENT,
          session: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.kill(session, 'SIGKILL');
        return;
      }
      for (const body of bodies) this.fromServer(session, body);
    });
    session.child.stderr?.on('data', (chunk: Buffer) => {
      session.stderrTail = `${session.stderrTail}${chunk.toString('utf8')}`.slice(-2_000);
    });
    session.child.on('error', (error) => {
      session.stderrTail = `${session.stderrTail}\n${error.message}`.slice(-2_000);
    });
    session.child.on('close', (code, signal) => {
      const wasReady = session.state === 'ready';
      session.state = 'exited';
      session.exit = { code, signal };
      for (const resolve of session.pending.values()) {
        resolve({ jsonrpc: '2.0', error: { code: -32000, message: 'The server exited.' } });
      }
      session.pending.clear();
      // The editor learns the server is gone the way it learns anything
      // else: a message on the stream, this one the worker's own.
      this.toClient(session, {
        jsonrpc: '2.0',
        method: '$/renkei/exited',
        params: { code, signal, stderr: session.stderrTail.trim() },
      });
      if (wasReady) {
        logger.info('language server {server} exited ({session}): code {code} signal {signal}', {
          component: COMPONENT,
          server: session.server,
          session: session.id,
          code,
          signal,
        });
      }
    });
  }

  private async initialize(
    session: Session
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const response = await this.requestServer(
      session,
      'initialize',
      {
        // Null, never this worker's pid: a server checks the pid it is
        // given with a zero signal every few seconds and exits when that
        // fails, and a process running as the project's uid cannot
        // signal this root-owned one — so the server would die three
        // seconds after starting, every time. The worker's own lifecycle
        // handling (close, idle, exit) is what ends a server here.
        processId: null,
        clientInfo: { name: 'renkei-code-pane', version: '1' },
        locale: 'en',
        rootUri: session.rootUri,
        rootPath: new URL(session.rootUri).pathname,
        workspaceFolders: null,
        capabilities: clientCapabilities(),
        initializationOptions: initializationOptions(session.server),
        trace: 'off',
      },
      LSP_INIT_TIMEOUT_MS
    );
    if (!response) {
      return {
        ok: false,
        message: `The ${languageServerSpec(session.server).label} server did not answer initialize within ${Math.round(LSP_INIT_TIMEOUT_MS / 1000)}s.${session.stderrTail ? ` It said: ${session.stderrTail.trim().slice(-500)}` : ''}`,
      };
    }
    if (response.error !== undefined || !isRecord(response.result)) {
      const said = isRecord(response.error) ? String(response.error.message ?? '') : '';
      return {
        ok: false,
        message: `The ${languageServerSpec(session.server).label} server refused initialize${said ? `: ${said}` : ''}.${session.stderrTail ? ` stderr: ${session.stderrTail.trim().slice(-500)}` : ''}`,
      };
    }
    session.capabilities = response.result.capabilities ?? {};
    session.serverInfo = response.result.serverInfo ?? null;
    this.writeServer(session, { jsonrpc: '2.0', method: 'initialized', params: {} });
    return { ok: true };
  }

  /** A request of this worker's own to the server: initialize, shutdown. Null when it times out. */
  private requestServer(
    session: Session,
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<Record<string, unknown> | null> {
    const id = `renkei-${session.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      session.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.writeServer(session, { jsonrpc: '2.0', id, method, params });
    });
  }

  private writeServer(
    session: Session,
    message: JsonRpcMessage | Record<string, unknown>
  ): boolean {
    if (session.state === 'exited' || !session.child.stdin?.writable) return false;
    try {
      session.child.stdin.write(frame(JSON.stringify(message)));
      return true;
    } catch {
      return false;
    }
  }

  /** One message off the server's stdout: the worker's own, answered here; the rest, the editor's. */
  private fromServer(session: Session, body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const id = message.id;
    // A response to this worker's own request.
    if (typeof id === 'string' && id.startsWith('renkei-') && message.method === undefined) {
      const resolve = session.pending.get(id);
      if (resolve) {
        session.pending.delete(id);
        resolve(message);
      }
      return;
    }
    // A server→client request about this process rather than the editor.
    if (typeof message.method === 'string' && id !== undefined && id !== null) {
      const answered = this.answerServerRequest(session, message.method, message.params);
      if (answered !== undefined) {
        this.writeServer(session, { jsonrpc: '2.0', id, result: answered });
        return;
      }
    }
    // Progress, log and telemetry noise the editor does not draw.
    if (message.method === 'telemetry/event' || message.method === '$/logTrace') return;
    this.toClient(session, message);
  }

  /** The worker's answers to a server; `undefined` means the editor should answer instead. */
  private answerServerRequest(session: Session, method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/configuration': {
        const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
        return items.map((item) => configurationFor(session.server, item));
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        return null;
      case 'workspace/workspaceFolders':
        return [{ uri: session.rootUri, name: 'checkout' }];
      case 'workspace/applyEdit':
        return {
          applied: false,
          failureReason: 'The code pane applies no edits of a server’s own.',
        };
      default:
        return undefined;
    }
  }

  private toClient(session: Session, message: unknown): void {
    const text = JSON.stringify(message);
    if (session.listener) {
      session.listener(text);
      return;
    }
    session.buffer.push(text);
    if (session.buffer.length > LSP_BUFFER_MAX_MESSAGES) {
      session.buffer.splice(0, session.buffer.length - LSP_BUFFER_MAX_MESSAGES);
    }
  }

  /** The checkout root a session's messages must stay inside, for the verb's check; null for no such session. */
  rootUriOf(id: string, owner: LspOwner): string | null {
    return this.owned(id, owner)?.rootUri ?? null;
  }

  /** The editor's message to the server, already validated by the verb. */
  send(
    id: string,
    owner: LspOwner,
    message: JsonRpcMessage
  ): { ok: true } | { ok: false; status: number; type: string; message: string } {
    const session = this.owned(id, owner);
    if (!session) return noSuchSession();
    if (session.state !== 'ready') {
      return { ok: false, status: 409, type: 'session_gone', message: exitedMessage(session) };
    }
    session.lastActivity = Date.now();
    if (!this.writeServer(session, message)) {
      return { ok: false, status: 409, type: 'session_gone', message: exitedMessage(session) };
    }
    return { ok: true };
  }

  /**
   * Attach the editor's events stream: what the server said while nobody
   * listened comes first, then everything after, live. One listener per
   * session — a second attach replaces the first (a reconnect), never
   * doubles the stream. Every text goes through `scrub` first (the
   * verb's: the owner's environment values masked), synchronously, so
   * messages keep their order. Answers the detach.
   */
  subscribe(
    id: string,
    owner: LspOwner,
    listener: Listener,
    scrub: (text: string) => string = (text) => text
  ):
    | { ok: true; detach: () => void }
    | { ok: false; status: number; type: string; message: string } {
    const session = this.owned(id, owner);
    if (!session) return noSuchSession();
    const deliver: Listener = (text) => listener(scrub(text));
    session.lastActivity = Date.now();
    session.listener = deliver;
    const backlog = session.buffer.splice(0);
    for (const text of backlog) deliver(text);
    if (session.state === 'exited') {
      deliver(
        JSON.stringify({
          jsonrpc: '2.0',
          method: '$/renkei/exited',
          params: {
            code: session.exit?.code ?? null,
            signal: session.exit?.signal ?? null,
            stderr: '',
          },
        })
      );
    }
    return {
      ok: true,
      detach: () => {
        if (session.listener === deliver) {
          session.listener = null;
          session.lastActivity = Date.now();
        }
      },
    };
  }

  async close(id: string, owner: LspOwner): Promise<boolean> {
    const session = this.owned(id, owner);
    if (!session) return false;
    await this.shutdown(session);
    return true;
  }

  /** The polite end: shutdown, exit, and a kill if the server lingers. */
  private async shutdown(session: Session): Promise<void> {
    this.sessions.delete(session.id);
    if (session.state === 'exited') return;
    const answered = await this.requestServer(session, 'shutdown', null, SHUTDOWN_GRACE_MS);
    if (answered) this.writeServer(session, { jsonrpc: '2.0', method: 'exit' });
    await new Promise<void>((resolve) => {
      if (session.state === 'exited') return resolve();
      const timer = setTimeout(() => {
        this.kill(session, 'SIGKILL');
        resolve();
      }, SHUTDOWN_GRACE_MS);
      session.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private kill(session: Session, signal: NodeJS.Signals): void {
    if (session.child.pid === undefined) return;
    try {
      process.kill(-session.child.pid, signal);
    } catch {
      try {
        session.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  /** Sessions with no listener and no message for LSP_IDLE_MS, and exited ones, are let go. */
  async reapIdle(now = Date.now()): Promise<number> {
    let reaped = 0;
    for (const session of [...this.sessions.values()]) {
      const idle = session.listener === null && now - session.lastActivity > LSP_IDLE_MS;
      if (session.state === 'exited' || idle) {
        await this.shutdown(session);
        reaped += 1;
      }
    }
    return reaped;
  }

  /** Every server, on the way out. */
  async closeAll(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.values()].map((session) => this.shutdown(session)));
  }
}

function noSuchSession(): { ok: false; status: number; type: string; message: string } {
  return { ok: false, status: 404, type: 'not_found', message: 'No such language server session.' };
}

function exitedMessage(session: Session): string {
  const exit = session.exit;
  const how = exit
    ? exit.signal
      ? `was killed (${exit.signal})`
      : `exited with code ${exit.code ?? 'unknown'}`
    : 'is not ready';
  return `The ${languageServerSpec(session.server).label} server ${how}; open it again.`;
}

/**
 * What a server is told at start, per server. Kept to what makes a
 * server useful in a checkout it has never seen, with nothing the
 * repository's own configuration would not already say.
 */
export function initializationOptions(server: LanguageServerId): Record<string, unknown> {
  switch (server) {
    case 'typescript':
      return {
        hostInfo: 'renkei',
        preferences: {
          includeCompletionsForModuleExports: true,
          includeCompletionsWithInsertText: true,
        },
        tsserver: { logVerbosity: 'off' },
      };
    case 'java':
      return { settings: { java: { configuration: { updateBuildConfiguration: 'automatic' } } } };
    case 'rust':
      return {
        checkOnSave: false,
        cargo: { buildScripts: { enable: false } },
        procMacro: { enable: false },
      };
    default:
      return {};
  }
}

/** The answer to a server's `workspace/configuration` item; nothing is configured, some servers want a shape. */
export function configurationFor(server: LanguageServerId, item: unknown): unknown {
  const section = isRecord(item) && typeof item.section === 'string' ? item.section : '';
  if (server === 'python') {
    if (section === 'python')
      return { analysis: { autoSearchPaths: true, diagnosticMode: 'openFilesOnly' } };
    if (section === 'python.analysis')
      return { autoSearchPaths: true, diagnosticMode: 'openFilesOnly' };
    return null;
  }
  if (server === 'rust' && section === 'rust-analyzer') return initializationOptions('rust');
  return null;
}

/** Start a server the way the checkout's commands start: its uid, its directory, an environment from nothing. */
function spawnServer(input: OpenSessionInput, sessionId: string): ChildProcess {
  const spec = languageServerSpec(input.server);
  const args = serverArgs(spec, { home: input.home, session: sessionId });
  const runInput: RunInput = {
    cwd: input.rootDir,
    home: input.home,
    identity: input.identity,
    env: {},
    timeoutMs: 0,
    extraEnv: {
      // The Node-based servers otherwise size their heap to the machine.
      NODE_OPTIONS: '--max-old-space-size=2048',
      // Scratch files (tsserver's logs and typings installs) under the
      // caller's own home, not a shared /tmp.
      TMPDIR: `${input.home}/.cache/tmp`,
    },
  };
  // Behind the shell prelude for its process and file-size limits, then
  // exec'd so the server IS the process the group is killed by.
  const wrapped = wrapCommand(input.identity, 'bash', [
    '-c',
    `${shellPrelude()}mkdir -p "$TMPDIR" 2>/dev/null\nexec "$@"`,
    'lsp',
    spec.command,
    ...args,
  ]);
  return spawn(wrapped.file, wrapped.args, {
    cwd: input.rootDir,
    env: childEnvironment(runInput),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
}
