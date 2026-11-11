/**
 * Code project previews — the I/O half: a project's own server started
 * in its checkout as a long-lived process, the ports it listens on, its
 * output, and the HTTP proxy that carries a request from the web app to
 * it and the answer back. The pure half (bounds, names, the port pool,
 * what the process is told, header shaping) is @renkei/connector-sandbox's
 * previews.ts; the HTTP surface is preview-endpoints.ts.
 *
 * A preview is a `code_run` that does not end: the same uid drop, the
 * same prelude and limits, the same environment built from nothing plus
 * the project's variables and its services' addresses — with `PORT` (and
 * `PORT_<NAME>` for each port it declared) set from this worker's pool
 * and `RENKEI_PREVIEW_URL` to where the web app serves it. The pool is
 * the system's (SANDBOX_PREVIEW_PORTS, 10000-10050 by default), handed
 * out lowest free first: a preview never picks a port, and the pool's
 * size is the ceiling on what runs at once. The process is reached only
 * from this worker's own loopback: nothing is published on the
 * container, and the web app's routes (which check the person's
 * session, or a port's share token) are the one way in from outside.
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
  DEFAULT_PREVIEW_PORT_RANGE,
  PREVIEW_LOG_MAX_LINES,
  PREVIEW_MAX_PER_SUBJECT,
  PREVIEW_PROXY_TIMEOUT_MS,
  PREVIEW_TTL_MS,
  previewEnvironment,
  previewNeighbourEnvironment,
  previewPortPool,
  stripHopByHop,
  upstreamRequestHeaders,
  type PreviewPortBinding,
  type PreviewPortRange,
  type PreviewStatus,
} from '@renkei/connector-sandbox';
import { childEnvironment, shellPrelude, wrapCommand, type ExecIdentity } from './workspaces';
import { actorAttrs } from '@renkei/db';
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
  /** The ports, the first primary. */
  ports: PreviewPortBinding[];
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

/** One port a start asks for: its name, and how the web app will serve it. */
export interface PreviewPortRequest {
  name: string;
  token: string | null;
  url: string;
}

export interface PreviewStartInput {
  workspace: { id: string; cwd: string; home: string; identity: ExecIdentity | null };
  name: string;
  command: string;
  /** The ports, by name, first one primary; each with where the web app serves it. */
  ports: PreviewPortRequest[];
  /** The caller's own variables (opened env secrets). */
  env: Record<string, string>;
  /** The running services' and other previews' variables, over the caller's. */
  extraEnv: Record<string, string>;
  /** How long to wait for the first port to accept connections before answering anyway. */
  waitMs: number;
}

export class PreviewManager {
  private readonly previews = new Map<string, Running>();
  private readonly ttlMs: number;
  readonly range: PreviewPortRange;

  constructor(options: { ttlMs?: number; portRange?: PreviewPortRange } = {}) {
    this.ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
    this.range = options.portRange ?? DEFAULT_PREVIEW_PORT_RANGE;
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

  /** Every port a preview on this worker holds, exited ones included until they are replaced. */
  private heldPorts(): Set<number> {
    const held = new Set<number>();
    for (const preview of this.previews.values()) {
      for (const binding of preview.ports) held.add(binding.port);
    }
    return held;
  }

  /**
   * `count` ports from the pool, lowest free first: not held by a preview
   * and nothing listening on them. Fewer than that free is a refusal
   * that says how wide the pool is.
   */
  private async allocatePorts(count: number): Promise<number[]> {
    const held = this.heldPorts();
    const taken: number[] = [];
    for (const port of previewPortPool(this.range)) {
      if (taken.length === count) break;
      if (held.has(port)) continue;
      if (await portIsFree(port)) taken.push(port);
    }
    if (taken.length < count) {
      throw new PreviewOpError(
        'port_in_use',
        `The sandbox's preview ports (${this.range.min}-${this.range.max}) have only ${taken.length} free and this preview needs ${count}; stop a preview first.`
      );
    }
    return taken;
  }

  async start(
    target: PreviewTarget,
    input: PreviewStartInput
  ): Promise<{ preview: StoredPreview; listening: string[] }> {
    const existing = this.find(target, input.name);
    if (existing) {
      if (existing.status !== 'exited') {
        throw new PreviewOpError(
          'exists',
          `A preview named ${input.name} is already ${existing.status} on port ${existing.ports[0]?.port}; stop it first, or pick another name.`
        );
      }
      // An exited one under that name makes way (and gives its ports back).
      this.previews.delete(existing.id);
    }
    const live = this.of(target).filter((preview) => preview.status !== 'exited');
    if (live.length >= PREVIEW_MAX_PER_SUBJECT) {
      throw new PreviewOpError(
        'quota_exceeded',
        `A project runs at most ${PREVIEW_MAX_PER_SUBJECT} previews at once; stop one first.`
      );
    }
    if (input.ports.length === 0)
      throw new PreviewOpError('bad_request', 'A preview needs a port.');
    const numbers = await this.allocatePorts(input.ports.length);
    const ports: PreviewPortBinding[] = input.ports.map((request, index) => ({
      name: request.name,
      port: numbers[index]!,
      token: request.token,
      url: request.url,
    }));
    const now = new Date();
    const preview: Running = {
      id: randomUUID(),
      subject: target.subject,
      workspaceId: input.workspace.id,
      name: input.name,
      command: input.command,
      ports,
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
          extraEnv: { ...input.extraEnv, ...previewEnvironment(ports) },
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
    logger.info('{actor} started the preview "{name}" on port(s) {ports}', {
      component: 'worker-sandbox/previews',
      ...(await actorAttrs(target.subject)),
      name: preview.name,
      ports: ports.map((binding) => `${binding.name}=${binding.port}`).join(','),
    });

    // The first port listening, the process exited, or the wait is up:
    // whichever comes first. Then which ports answer right now.
    const deadline = Date.now() + input.waitMs;
    const primary = ports[0]!.port;
    while (preview.status !== 'exited' && Date.now() < deadline) {
      if (await portAccepts(primary)) break;
      await sleep(READY_POLL_MS);
    }
    const listening: string[] = [];
    if (preview.status !== 'exited') {
      for (const binding of ports) {
        if (await portAccepts(binding.port)) listening.push(binding.name);
      }
    }
    if (listening.length) preview.status = 'running';
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
    return { ...summary, ports: summary.ports.map((binding) => ({ ...binding })) };
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

  /** The preview and port a share token names, if the preview is still up. */
  byToken(token: string): { preview: StoredPreview; port: PreviewPortBinding } | null {
    for (const preview of this.previews.values()) {
      if (preview.status === 'exited') continue;
      const port = preview.ports.find((binding) => binding.token === token);
      if (port) return { preview: this.summary(preview), port: { ...port } };
    }
    return null;
  }

  /**
   * The preview and port a (subject, name, port name) names for the proxy,
   * if the preview is still up; no port name means the first port.
   */
  reachable(
    target: PreviewTarget,
    name: string,
    portName?: string | null
  ): { preview: StoredPreview; port: PreviewPortBinding } | null {
    const preview = this.find(target, name);
    if (!preview || preview.status === 'exited') return null;
    const port = portName
      ? preview.ports.find((binding) => binding.name === portName)
      : preview.ports[0];
    return port ? { preview: this.summary(preview), port: { ...port } } : null;
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
    logger.info('{actor} stopped the preview "{name}"', {
      component: 'worker-sandbox/previews',
      ...(await actorAttrs(target.subject)),
      name,
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

  /**
   * What a command — or another preview — in the project is told about the
   * previews that are up: PREVIEW_<NAME>_PORT / _URL for each and per
   * named port, `except` the one being started itself.
   */
  environmentFor(target: PreviewTarget, except?: string): Record<string, string> {
    return previewNeighbourEnvironment(
      this.of(target)
        .filter((preview) => preview.status !== 'exited' && preview.name !== except)
        .map((preview) => ({ name: preview.name, ports: preview.ports }))
    );
  }

  /** A request reached the preview: it lives on. */
  touch(id: string): void {
    const preview = this.previews.get(id);
    if (preview) preview.lastUsedAt = new Date();
  }

  /**
   * One request to a port of the preview's server on the loopback, its
   * answer streamed back as it comes. Hop-by-hop headers stop at each
   * side; the `host` the server sees is its own loopback address, which
   * is what a dev server's host check expects, and `x-forwarded-*` from
   * the web app say where the request really came from.
   */
  proxy(
    preview: StoredPreview,
    port: number,
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ): void {
    this.touch(preview.id);
    const headers = upstreamRequestHeaders(request.headers);
    headers.host = `127.0.0.1:${port}`;
    // A reverse proxy is the feature: the host is this worker's own
    // loopback and the port one the pool handed the preview — neither is
    // the request's — and the path is what the browser asked the preview's
    // server for, which is what a proxy relays.
    // codeql[js/request-forgery]
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
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
          message: `The preview ${preview.name} did not answer on port ${port}: ${error.message}`,
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
      logger.info('the preview "{name}" of {actor} sat idle past its lifetime and was stopped', {
        component: 'worker-sandbox/previews',
        ...(await actorAttrs(preview.subject)),
        name: preview.name,
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
