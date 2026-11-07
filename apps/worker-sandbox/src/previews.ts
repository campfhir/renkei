/**
 * Code project previews — the I/O half: a project's own server started
 * in its checkout as a long-lived process, the port it listens on, its
 * output, and the HTTP proxy that carries a request from the web app to
 * it and the answer back. The pure half (bounds, names, what the process
 * is told, header shaping) is @renkei/connector-sandbox's previews.ts;
 * the HTTP surface is preview-endpoints.ts.
 *
 * A preview is a `code_run` that does not end: the same uid drop, the
 * same prelude and limits, the same environment built from nothing plus
 * the project's variables and its services' addresses — with `PORT` set
 * to a port this worker chose (or the one the project insists on) and
 * `RENKEI_PREVIEW_URL` to where the web app serves it. The process is
 * reached only from this worker's own loopback: nothing is published on
 * the container, and the web app's routes (which check the person's
 * session, or a share token) are the one way in from outside.
 *
 * It is working state kept in memory: a preview lives in this process's
 * table and process tree, for PREVIEW_TTL_MS past its last request, and
 * not past this worker. A restart takes every preview with it, and the
 * list says so by saying nothing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer } from 'node:net';
import {
  PREVIEW_LOG_MAX_LINES,
  PREVIEW_MAX_PER_SUBJECT,
  PREVIEW_PORT_MAX,
  PREVIEW_PORT_MIN,
  PREVIEW_PROXY_TIMEOUT_MS,
  PREVIEW_TTL_MS,
  previewEnvironment,
  stripHopByHop,
  type PreviewStatus,
} from '@renkei/connector-sandbox';
import { childEnvironment, shellPrelude, wrapCommand, type ExecIdentity } from './workspaces';
import { logger } from './logger';

export interface PreviewTarget {
  subject: string;
}

export interface PreviewLogLine {
  at: string;
  stream: 'stdout' | 'stderr' | 'worker';
  line: string;
}

export interface StoredPreview {
  id: string;
  subject: string;
  workspaceId: string;
  name: string;
  command: string;
  port: number;
  /** The share token the web app minted, when the preview is public; null otherwise. */
  token: string | null;
  /** Where the web app serves it — what the process was told. */
  url: string;
  status: PreviewStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: Date;
  lastUsedAt: Date;
}

export class PreviewOpError extends Error {
  constructor(
    readonly type:
      'not_found' | 'exists' | 'quota_exceeded' | 'bad_request' | 'port_in_use' | 'start_failed',
    message: string
  ) {
    super(message);
    this.name = 'PreviewOpError';
  }
}

interface Running extends StoredPreview {
  child: ChildProcess | null;
  logs: PreviewLogLine[];
  /** Resolves when the process has exited. */
  exited: Promise<void>;
}

const KILL_GRACE_MS = 5_000;
const READY_POLL_MS = 250;
const PORT_TRIES = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether something already listens on the port, from this worker's point of view. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Whether something accepts a connection on the loopback at the port. */
export function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface PreviewStartInput {
  workspace: { id: string; cwd: string; home: string; identity: ExecIdentity | null };
  name: string;
  command: string;
  /** The port the project insists on, or null for one of this worker's choosing. */
  port: number | null;
  /** The caller's own variables (opened env secrets). */
  env: Record<string, string>;
  /** The running services' variables, over the caller's. */
  extraEnv: Record<string, string>;
  token: string | null;
  /** Where the web app serves the preview (the public address when there is a token). */
  url: string;
  /** How long to wait for the server to accept connections before answering anyway. */
  waitMs: number;
}

export class PreviewManager {
  private readonly previews = new Map<string, Running>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
  }

  expiresAt(preview: StoredPreview): Date {
    return new Date(preview.lastUsedAt.getTime() + this.ttlMs);
  }

  private of(target: PreviewTarget): Running[] {
    return [...this.previews.values()]
      .filter((preview) => preview.subject === target.subject)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private find(target: PreviewTarget, name: string): Running | undefined {
    return this.of(target).find((preview) => preview.name === name);
  }

  /** A port nothing listens on and no preview holds: the caller's, checked, or one from the range. */
  private async allocatePort(fixed: number | null): Promise<number> {
    const held = new Set([...this.previews.values()].map((preview) => preview.port));
    if (fixed !== null) {
      if (held.has(fixed) || !(await portIsFree(fixed))) {
        throw new PreviewOpError(
          'port_in_use',
          `Port ${fixed} is already in use on the sandbox; stop what holds it, or leave the port to the sandbox (PORT is set for the command).`
        );
      }
      return fixed;
    }
    for (let attempt = 0; attempt < PORT_TRIES; attempt += 1) {
      const port =
        PREVIEW_PORT_MIN + Math.floor(Math.random() * (PREVIEW_PORT_MAX - PREVIEW_PORT_MIN + 1));
      if (held.has(port)) continue;
      if (await portIsFree(port)) return port;
    }
    throw new PreviewOpError('start_failed', 'No free port could be found for the preview.');
  }

  async start(
    target: PreviewTarget,
    input: PreviewStartInput
  ): Promise<{ preview: StoredPreview; listening: boolean }> {
    const existing = this.find(target, input.name);
    if (existing) {
      if (existing.status !== 'exited') {
        throw new PreviewOpError(
          'exists',
          `A preview named ${input.name} is already ${existing.status} on port ${existing.port}; stop it first, or pick another name.`
        );
      }
      // An exited one under that name makes way.
      this.previews.delete(existing.id);
    }
    const live = this.of(target).filter((preview) => preview.status !== 'exited');
    if (live.length >= PREVIEW_MAX_PER_SUBJECT) {
      throw new PreviewOpError(
        'quota_exceeded',
        `A project runs at most ${PREVIEW_MAX_PER_SUBJECT} previews at once; stop one first.`
      );
    }
    const port = await this.allocatePort(input.port);
    const now = new Date();
    const preview: Running = {
      id: randomUUID(),
      subject: target.subject,
      workspaceId: input.workspace.id,
      name: input.name,
      command: input.command,
      port,
      token: input.token,
      url: input.url,
      status: 'starting',
      exitCode: null,
      signal: null,
      startedAt: now,
      lastUsedAt: now,
      child: null,
      logs: [],
      exited: Promise.resolve(),
    };
    const wrapped = wrapCommand(
      input.workspace.identity,
      'bash',
      ['-c', `${shellPrelude()}${input.command}`],
      null
    );
    let child: ChildProcess;
    try {
      // The project's own server command is the feature; what contains it
      // is the uid drop and the limits wrapCommand puts around it.
      // codeql[js/command-line-injection] codeql[js/indirect-command-line-injection]
      child = spawn(wrapped.file, wrapped.args, {
        cwd: input.workspace.cwd,
        env: childEnvironment({
          cwd: input.workspace.cwd,
          home: input.workspace.home,
          identity: input.workspace.identity,
          env: input.env,
          timeoutMs: 0,
          extraEnv: { ...input.extraEnv, ...previewEnvironment(port, input.url) },
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      throw new PreviewOpError(
        'start_failed',
        `The preview could not be started: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    preview.child = child;
    this.collect(preview, child, 'stdout');
    this.collect(preview, child, 'stderr');
    preview.exited = new Promise<void>((resolve) => {
      child.on('error', (error) => {
        this.log(preview, 'worker', `could not start: ${error.message}`);
      });
      child.on('close', (code, signal) => {
        preview.status = 'exited';
        preview.exitCode = code;
        preview.signal = signal;
        preview.child = null;
        this.log(
          preview,
          'worker',
          `exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`
        );
        resolve();
      });
    });
    this.previews.set(preview.id, preview);
    logger.info('started preview {name} for {subject} on port {port}', {
      component: 'worker-sandbox/previews',
      name: preview.name,
      subject: target.subject,
      port,
    });

    // Listening, exited, or the wait is up: whichever comes first.
    const deadline = Date.now() + input.waitMs;
    let listening = false;
    while (preview.status !== 'exited' && Date.now() < deadline) {
      if (await portAccepts(port)) {
        listening = true;
        break;
      }
      await sleep(READY_POLL_MS);
    }
    if (listening) preview.status = 'running';
    return { preview: this.summary(preview), listening };
  }

  private collect(preview: Running, child: ChildProcess, stream: 'stdout' | 'stderr'): void {
    let rest = '';
    child[stream]?.setEncoding('utf8');
    child[stream]?.on('data', (chunk: string) => {
      const text = rest + chunk;
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) this.log(preview, stream, line.replace(/\r$/, ''));
    });
    child[stream]?.on('end', () => {
      if (rest) this.log(preview, stream, rest);
      rest = '';
    });
  }

  private log(preview: Running, stream: PreviewLogLine['stream'], line: string): void {
    preview.logs.push({ at: new Date().toISOString(), stream, line });
    if (preview.logs.length > PREVIEW_LOG_MAX_LINES) {
      preview.logs.splice(0, preview.logs.length - PREVIEW_LOG_MAX_LINES);
    }
  }

  private summary(preview: Running): StoredPreview {
    const { child: _child, logs: _logs, exited: _exited, ...summary } = preview;
    return { ...summary };
  }

  list(target: PreviewTarget): StoredPreview[] {
    return this.of(target).map((preview) => this.summary(preview));
  }

  get(target: PreviewTarget, name: string): StoredPreview {
    const preview = this.find(target, name);
    if (!preview) throw new PreviewOpError('not_found', `No preview named ${name} — see the list.`);
    return this.summary(preview);
  }

  /** The last `lines` of a preview's output, oldest first. */
  logs(target: PreviewTarget, name: string, lines: number): PreviewLogLine[] {
    const preview = this.find(target, name);
    if (!preview) throw new PreviewOpError('not_found', `No preview named ${name} — see the list.`);
    return preview.logs.slice(-lines);
  }

  /** The preview a share token names, if it is still up. */
  byToken(token: string): StoredPreview | null {
    for (const preview of this.previews.values()) {
      if (preview.token === token && preview.status !== 'exited') return this.summary(preview);
    }
    return null;
  }

  /** The preview a (subject, name) names for the proxy, if it is still up. */
  reachable(target: PreviewTarget, name: string): StoredPreview | null {
    const preview = this.find(target, name);
    return preview && preview.status !== 'exited' ? this.summary(preview) : null;
  }

  private async kill(preview: Running): Promise<void> {
    const child = preview.child;
    if (!child || child.pid === undefined) return;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    signalGroup('SIGTERM');
    const timer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    await preview.exited;
    clearTimeout(timer);
  }

  async stop(target: PreviewTarget, name: string): Promise<StoredPreview> {
    const preview = this.find(target, name);
    if (!preview) throw new PreviewOpError('not_found', `No preview named ${name} — see the list.`);
    await this.kill(preview);
    this.previews.delete(preview.id);
    logger.info('stopped preview {name} for {subject}', {
      component: 'worker-sandbox/previews',
      name,
      subject: target.subject,
    });
    return this.summary(preview);
  }

  /** Every preview of a checkout, stopped — the checkout is going away. */
  async stopForWorkspace(workspaceId: string): Promise<void> {
    for (const preview of this.previews.values()) {
      if (preview.workspaceId !== workspaceId) continue;
      await this.kill(preview);
      this.previews.delete(preview.id);
    }
  }

  /** A request reached the preview: it lives on. */
  touch(id: string): void {
    const preview = this.previews.get(id);
    if (preview) preview.lastUsedAt = new Date();
  }

  /**
   * One request to the preview's server on the loopback, its answer
   * streamed back as it comes. Hop-by-hop headers stop at each side; the
   * `host` the server sees is its own loopback address, which is what a
   * dev server's host check expects, and `x-forwarded-*` from the web
   * app say where the request really came from.
   */
  proxy(
    preview: StoredPreview,
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ): void {
    this.touch(preview.id);
    const headers = stripHopByHop(request.headers);
    headers.host = `127.0.0.1:${preview.port}`;
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: preview.port,
        method: request.method,
        path,
        headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, stripHopByHop(answer.headers));
        answer.pipe(response);
        answer.on('error', () => response.destroy());
      }
    );
    upstream.setTimeout(PREVIEW_PROXY_TIMEOUT_MS, () => {
      upstream.destroy(new Error('the preview did not answer in time'));
    });
    upstream.on('error', (error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const payload = JSON.stringify({
        error: {
          type: 'preview_unreachable',
          message: `The preview ${preview.name} did not answer on port ${preview.port}: ${error.message}`,
        },
      });
      response.writeHead(502, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  }

  /** Previews past their lifetime stopped and forgotten; how many went. */
  async sweep(now = Date.now()): Promise<number> {
    let swept = 0;
    for (const preview of [...this.previews.values()]) {
      if (this.expiresAt(preview).getTime() > now) continue;
      await this.kill(preview);
      this.previews.delete(preview.id);
      swept += 1;
      logger.info('swept idle preview {name} ({subject})', {
        component: 'worker-sandbox/previews',
        name: preview.name,
        subject: preview.subject,
      });
    }
    return swept;
  }

  /** On shutdown: every preview's process tree, since none outlives this worker. */
  async stopAll(): Promise<number> {
    const all = [...this.previews.values()];
    this.previews.clear();
    await Promise.all(all.map((preview) => this.kill(preview)));
    return all.length;
  }

  count(): number {
    return this.previews.size;
  }
}
