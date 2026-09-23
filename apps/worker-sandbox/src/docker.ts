/**
 * A small client for the Docker Engine API — exactly the handful of
 * calls code project services need (services.ts): pull an image, make
 * sure a network exists and this worker's own container is on it, create
 * and start a container on it, look it up, read its logs, stop and
 * remove it. Plain node:http over the engine's unix socket (or a TCP
 * proxy in front of it), no dependency: the surface is ten endpoints,
 * and a dependency that wraps all two hundred is not worth its weight in
 * an image whose whole point is holding little.
 *
 * Where the engine is: SANDBOX_DOCKER_HOST, `unix:///var/run/docker.sock`
 * by default (the socket compose mounts into this container, root-only —
 * a caller's uid cannot open it), or `tcp://host:port` for a deployment
 * that puts a socket proxy between this worker and the engine, allowing
 * only the calls below. Either way the engine answers to this PROCESS,
 * which is root; nothing a project's command runs can reach it.
 *
 * The `DockerEngine` interface is what services.ts programs against, so
 * a test can hand it a scripted engine and never touch a socket.
 */

import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON from the engine, or null when it is not JSON — never a throw. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

export interface ContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  network: string;
  memoryBytes: number;
  pidsLimit: number;
}

export interface LogOptions {
  since?: string;
  timestamps?: boolean;
}

export interface ContainerState {
  id: string;
  running: boolean;
  /** The engine's own word: created, running, exited, dead, ... */
  status: string;
  exitCode: number | null;
  /** The address on the named network, when attached to it and running. */
  ip: string | null;
}

export interface DockerEngine {
  /** The engine's version — a liveness probe for the boot check. */
  version(): Promise<{ version: string; apiVersion: string }>;
  /** Pull `host/path` at `tag` (a tag or a `sha256:` digest); auth rides the X-Registry-Auth header. */
  pullImage(
    repository: string,
    tag: string,
    auth: RegistryAuth | null,
    timeoutMs: number
  ): Promise<void>;
  /** The ports the image declares (EXPOSE), ascending. */
  imagePorts(reference: string): Promise<number[]>;
  /** Make sure the named network exists (internal: no route out of it). */
  ensureNetwork(name: string): Promise<void>;
  /** Attach a container (this worker's own) to the network; already attached is fine. */
  connectToNetwork(network: string, container: string): Promise<void>;
  createContainer(spec: ContainerSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  inspectContainer(id: string, network: string): Promise<ContainerState | null>;
  /**
   * The last `tail` lines of both streams, demultiplexed, oldest first;
   * with `since` (seconds[.nanoseconds] since the epoch) only lines after
   * it, with `timestamps` each line stamped as the engine stamps it.
   */
  containerLogs(id: string, tail: number, options?: LogOptions): Promise<string>;
  stopContainer(id: string, timeoutSeconds: number): Promise<void>;
  /** Remove with its anonymous volumes; already gone is fine. */
  removeContainer(id: string): Promise<void>;
  /** Ids of every container carrying the label. */
  listContainers(label: string): Promise<Array<{ id: string; labels: Record<string, string> }>>;
}

/** How the engine is reached, from SANDBOX_DOCKER_HOST. */
export interface DockerAddress {
  socketPath?: string;
  host?: string;
  port?: number;
}

export function parseDockerHost(raw: string | undefined): DockerAddress {
  const value = (raw ?? '').trim() || 'unix:///var/run/docker.sock';
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  if (value.startsWith('tcp://') || value.startsWith('http://')) {
    const url = new URL(value.replace(/^tcp:/, 'http:'));
    return { host: url.hostname, port: Number(url.port || '2375') };
  }
  if (value.startsWith('/')) return { socketPath: value };
  throw new Error(`SANDBOX_DOCKER_HOST is not a usable engine address: ${value}`);
}

/** The X-Registry-Auth header: the credential as base64url JSON, the way `docker login` would send it. */
export function registryAuthHeader(auth: RegistryAuth): string {
  return Buffer.from(JSON.stringify(auth), 'utf8').toString('base64url');
}

/**
 * Split the engine's multiplexed log stream (a container without a TTY)
 * into text: each frame is an 8-byte header — stream type, three zero
 * bytes, a big-endian payload length — then that many bytes. A stream
 * that carries no headers (a TTY container) is returned as it is.
 */
export function demultiplexLogs(raw: Buffer): string {
  if (raw.length === 0) return '';
  const first = raw[0];
  const looksFramed =
    (first === 0 || first === 1 || first === 2) && raw[1] === 0 && raw[2] === 0 && raw[3] === 0;
  if (!looksFramed) return raw.toString('utf8');
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const size = raw.readUInt32BE(offset + 4);
    const start = offset + 8;
    parts.push(raw.subarray(start, Math.min(raw.length, start + size)));
    offset = start + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The pull stream's error lines, if any — the engine answers 200 and then says the pull failed. */
export function pullStreamError(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A progress line that is not JSON is not an error.
    const parsed = parseJson(trimmed);
    if (isRecord(parsed) && typeof parsed.error === 'string') return parsed.error;
  }
  return null;
}

export function parseMemoryBytes(raw: string | undefined, fallback: number): number {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/.exec(value);
  if (!match) throw new Error(`not a memory size: ${raw}`);
  const scale = { '': 1, k: 1_024, m: 1_048_576, g: 1_073_741_824 }[match[2]!] ?? 1;
  return Math.floor(Number(match[1]) * scale);
}

interface EngineResponse {
  status: number;
  body: Buffer;
}

export class DockerClient implements DockerEngine {
  constructor(private readonly address: DockerAddress) {}

  private call(
    method: string,
    path: string,
    input: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<EngineResponse> {
    const payload =
      input.body === undefined ? null : Buffer.from(JSON.stringify(input.body), 'utf8');
    const options: RequestOptions = {
      method,
      path,
      headers: {
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {}),
        ...(input.headers ?? {}),
      },
      ...(this.address.socketPath
        ? { socketPath: this.address.socketPath }
        : { host: this.address.host, port: this.address.port }),
    };
    return new Promise((resolve, reject) => {
      const req = httpRequest(options, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) })
        );
        response.on('error', reject);
      });
      req.setTimeout(input.timeoutMs ?? 30_000, () => {
        req.destroy(new DockerError(`the engine did not answer ${method} ${path} in time`, 0));
      });
      req.on('error', (error: Error) =>
        reject(
          error instanceof DockerError
            ? error
            : new DockerError(`engine unreachable: ${error.message}`, 0)
        )
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  private static messageOf(response: EngineResponse): string {
    const text = response.body.toString('utf8');
    const parsed = parseJson(text);
    if (isRecord(parsed) && typeof parsed.message === 'string') return parsed.message;
    return text.trim() || `HTTP ${response.status}`;
  }

  /** A 2xx answer's body as JSON (an empty body reads as null); anything else is a DockerError. */
  private async json(
    method: string,
    path: string,
    input: Parameters<DockerClient['call']>[2] = {}
  ): Promise<unknown> {
    const response = await this.call(method, path, input);
    if (response.status < 200 || response.status >= 300) {
      throw new DockerError(DockerClient.messageOf(response), response.status);
    }
    return parseJson(response.body.toString('utf8') || 'null');
  }

  async version(): Promise<{ version: string; apiVersion: string }> {
    const got = await this.json('GET', '/version', { timeoutMs: 10_000 });
    const record = isRecord(got) ? got : {};
    return {
      version: typeof record.Version === 'string' ? record.Version : 'unknown',
      apiVersion: typeof record.ApiVersion === 'string' ? record.ApiVersion : 'unknown',
    };
  }

  async pullImage(
    repository: string,
    tag: string,
    auth: RegistryAuth | null,
    timeoutMs: number
  ): Promise<void> {
    const query = new URLSearchParams({ fromImage: repository, tag });
    const response = await this.call('POST', `/images/create?${query.toString()}`, {
      headers: auth ? { 'x-registry-auth': registryAuthHeader(auth) } : {},
      timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new DockerError(DockerClient.messageOf(response), response.status);
    }
    const failed = pullStreamError(response.body.toString('utf8'));
    if (failed) throw new DockerError(failed, 0);
  }

  async imagePorts(reference: string): Promise<number[]> {
    const got = await this.json('GET', `/images/${encodeURIComponent(reference)}/json`);
    const config = isRecord(got) && isRecord(got.Config) ? got.Config : {};
    const exposed = isRecord(config.ExposedPorts) ? config.ExposedPorts : {};
    const ports = new Set<number>();
    for (const key of Object.keys(exposed)) {
      const port = Number(key.split('/')[0]);
      if (Number.isInteger(port) && port > 0 && port < 65_536) ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
  }

  async ensureNetwork(name: string): Promise<void> {
    const existing = await this.call('GET', `/networks/${encodeURIComponent(name)}`);
    if (existing.status === 200) return;
    if (existing.status !== 404)
      throw new DockerError(DockerClient.messageOf(existing), existing.status);
    await this.json('POST', '/networks/create', {
      body: {
        Name: name,
        Driver: 'bridge',
        // No route out: a service is something the project's tests talk
        // to, not something that talks to the internet.
        Internal: true,
        Labels: { 'renkei.sandbox': '1' },
      },
    });
  }

  async connectToNetwork(network: string, container: string): Promise<void> {
    const response = await this.call('POST', `/networks/${encodeURIComponent(network)}/connect`, {
      body: { Container: container },
    });
    if (response.status >= 200 && response.status < 300) return;
    const message = DockerClient.messageOf(response);
    // Already on it: the engine says so with a 403 (and, in older engines, a 500).
    if (/already exists|already connected|already attached/i.test(message)) return;
    throw new DockerError(message, response.status);
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    const query = new URLSearchParams({ name: spec.name });
    const created = await this.json('POST', `/containers/create?${query.toString()}`, {
      body: {
        Image: spec.image,
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        Labels: spec.labels,
        HostConfig: {
          NetworkMode: spec.network,
          Memory: spec.memoryBytes,
          MemorySwap: spec.memoryBytes,
          PidsLimit: spec.pidsLimit,
          SecurityOpt: ['no-new-privileges:true'],
          RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
        },
        NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
      },
    });
    if (!isRecord(created) || typeof created.Id !== 'string') {
      throw new DockerError('the engine created the container without answering its id', 0);
    }
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    const response = await this.call('POST', `/containers/${encodeURIComponent(id)}/start`);
    // 304: already running.
    if (response.status === 204 || response.status === 304) return;
    throw new DockerError(DockerClient.messageOf(response), response.status);
  }

  async inspectContainer(id: string, network: string): Promise<ContainerState | null> {
    const response = await this.call('GET', `/containers/${encodeURIComponent(id)}/json`);
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new DockerError(DockerClient.messageOf(response), response.status);
    const got = parseJson(response.body.toString('utf8'));
    const record = isRecord(got) ? got : {};
    const state = isRecord(record.State) ? record.State : {};
    const settings = isRecord(record.NetworkSettings) ? record.NetworkSettings : {};
    const networks = isRecord(settings.Networks) ? settings.Networks : {};
    const endpoint = isRecord(networks[network]) ? networks[network] : {};
    const running = state.Running === true;
    const ip =
      typeof endpoint.IPAddress === 'string' && endpoint.IPAddress ? endpoint.IPAddress : null;
    return {
      id: typeof record.Id === 'string' ? record.Id : id,
      running,
      status: typeof state.Status === 'string' ? state.Status : 'unknown',
      exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
      ip: running ? ip : null,
    };
  }

  async containerLogs(id: string, tail: number, options: LogOptions = {}): Promise<string> {
    const query = new URLSearchParams({
      stdout: '1',
      stderr: '1',
      tail: String(tail),
      ...(options.since ? { since: options.since } : {}),
      ...(options.timestamps ? { timestamps: '1' } : {}),
    });
    const response = await this.call(
      'GET',
      `/containers/${encodeURIComponent(id)}/logs?${query.toString()}`
    );
    if (response.status === 404) throw new DockerError('no such container', 404);
    if (response.status !== 200)
      throw new DockerError(DockerClient.messageOf(response), response.status);
    return demultiplexLogs(response.body);
  }

  async stopContainer(id: string, timeoutSeconds: number): Promise<void> {
    const query = new URLSearchParams({ t: String(timeoutSeconds) });
    const response = await this.call(
      'POST',
      `/containers/${encodeURIComponent(id)}/stop?${query.toString()}`,
      {
        timeoutMs: (timeoutSeconds + 15) * 1000,
      }
    );
    // 304: already stopped; 404: already gone.
    if (response.status === 204 || response.status === 304 || response.status === 404) return;
    throw new DockerError(DockerClient.messageOf(response), response.status);
  }

  async removeContainer(id: string): Promise<void> {
    const query = new URLSearchParams({ v: '1', force: '1' });
    const response = await this.call(
      'DELETE',
      `/containers/${encodeURIComponent(id)}?${query.toString()}`,
      {
        timeoutMs: 60_000,
      }
    );
    if (response.status === 204 || response.status === 404) return;
    throw new DockerError(DockerClient.messageOf(response), response.status);
  }

  async listContainers(
    label: string
  ): Promise<Array<{ id: string; labels: Record<string, string> }>> {
    const query = new URLSearchParams({ all: '1', filters: JSON.stringify({ label: [label] }) });
    const got = await this.json('GET', `/containers/json?${query.toString()}`);
    if (!Array.isArray(got)) return [];
    const out: Array<{ id: string; labels: Record<string, string> }> = [];
    for (const entry of got) {
      if (!isRecord(entry) || typeof entry.Id !== 'string') continue;
      const labels: Record<string, string> = {};
      if (isRecord(entry.Labels)) {
        for (const [key, value] of Object.entries(entry.Labels)) {
          if (typeof value === 'string') labels[key] = value;
        }
      }
      out.push({ id: entry.Id, labels });
    }
    return out;
  }
}
