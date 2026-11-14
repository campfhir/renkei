/**
 * Sandboxes as containers the Docker engine runs: the local stand-in for
 * Azure Container Apps sandboxes, and a real provider for a single host.
 * One container per sandbox, made from the sandbox image, on the network
 * the callers share with it.
 *
 * What a container is given is what the one shared sandbox container was
 * given before (docker-compose.yaml's worker-sandbox): root inside, with
 * exactly the capabilities the worker needs to drop a command to its
 * caller's uid, no-new-privileges, a memory and a pids ceiling. Its disk
 * is the container's own (the image's /data and /workspaces volumes are
 * anonymous, made with it and removed with it), so removing a sandbox
 * removes everything it held.
 *
 * Suspending is `stop` by default: the disk is kept and the memory is
 * given back, which is what Azure's disk-mode suspend does. `pause`
 * (SANDBOX_DOCKER_SUSPEND=pause) keeps the processes too, like Azure's
 * memory mode, at the price of holding their memory while suspended.
 *
 * Where the worker answers: the container's address on the first
 * configured network, or — for an orchestrator run on the host beside a
 * web app that is also on the host — a loopback port the engine picks
 * (`publishHost`).
 */

import { isRecord } from '@renkei/guards';
import {
  createEngineTransport,
  engineMessage,
  parseDockerHost,
  parseEngineJson,
  type EngineResponse,
  type EngineTransport,
} from './docker-engine';
import {
  ProviderError,
  SANDBOX_WORKER_PORT,
  type ProviderSandbox,
  type ProviderSandboxState,
  type SandboxProvider,
  type SandboxSpec,
} from './provider';

/** Every container this provider makes; NOT the label the sandbox worker's own service sweep reaps by. */
export const DOCKER_MANAGED_LABEL = 'renkei.orchestrator.sandbox';
const LABEL_ID = 'renkei.orchestrator.sandbox-id';
const LABEL_KIND = 'renkei.orchestrator.kind';
const LABEL_DEPLOYMENT = 'renkei.orchestrator.deployment';

/** The capabilities the sandbox worker uses, and nothing else (docker-compose.yaml says why each). */
const CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID', 'SETPCAP'];

const STOP_GRACE_SECONDS = 25;

export interface DockerProviderOptions {
  /** The sandbox image, e.g. `renkei-sandbox:latest`. Must already be on the engine. */
  image: string;
  /** Networks a sandbox joins; its address is read from the first. */
  networks: string[];
  /** Publish the worker's port on this host address (e.g. `127.0.0.1`) and answer with that instead. */
  publishHost?: string | null;
  /** The container's command, when the image's own is not wanted. */
  command?: string[] | null;
  memoryBytes: number;
  shmBytes: number;
  pidsLimit: number;
  /** Fractional CPUs; 0 for no ceiling. */
  cpus: number;
  suspend: 'stop' | 'pause';
  /**
   * Let a sandbox run a container engine inside itself, for code project
   * services. An Azure sandbox is a microVM and simply can; a Docker
   * container can only when it is PRIVILEGED, which gives up the
   * capability limits above — a developer's machine, never a shared host.
   */
  nestedEngine?: boolean;
  /**
   * Names this deployment among others sharing an engine, so one
   * orchestrator never lists (and never removes) another's sandboxes.
   */
  deployment: string;
  transport?: EngineTransport;
  /** SANDBOX_DOCKER_HOST. */
  host?: string;
}

function ok(response: EngineResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function failure(response: EngineResponse): ProviderError {
  return new ProviderError(engineMessage(response), response.status);
}

function containerName(sandboxId: string): string {
  return `renkei-sandbox-${sandboxId}`;
}

/** The engine's `State` as the orchestrator's vocabulary. */
export function dockerState(state: Record<string, unknown>): ProviderSandboxState {
  const status = typeof state.Status === 'string' ? state.Status : '';
  if (state.Paused === true || status === 'paused') return 'suspended';
  if (state.Restarting === true || status === 'restarting') return 'starting';
  if (state.Running === true || status === 'running') return 'running';
  if (state.Dead === true || status === 'dead' || status === 'removing') return 'failed';
  // created, exited: stopped with its disk — `start` runs it again.
  return 'suspended';
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = 'docker';
  private readonly engine: EngineTransport;

  constructor(private readonly options: DockerProviderOptions) {
    if (options.networks.length === 0 && !options.publishHost) {
      throw new Error('the Docker provider needs a network to put sandboxes on, or a publish host');
    }
    this.engine = options.transport ?? createEngineTransport(parseDockerHost(options.host));
  }

  async check(): Promise<void> {
    const version = await this.engine.call('GET', '/version', { timeoutMs: 10_000 });
    if (!ok(version)) throw failure(version);
    const image = await this.engine.call(
      'GET',
      `/images/${encodeURIComponent(this.options.image)}/json`
    );
    if (image.status === 404) {
      throw new ProviderError(
        `the sandbox image ${this.options.image} is not on the engine; build or pull it first`,
        404
      );
    }
    if (!ok(image)) throw failure(image);
  }

  async create(spec: SandboxSpec): Promise<{ providerId: string }> {
    const { options } = this;
    const [primary, ...others] = options.networks;
    const port = `${SANDBOX_WORKER_PORT}/tcp`;
    const created = await this.engine.call(
      'POST',
      `/containers/create?${new URLSearchParams({ name: containerName(spec.sandboxId) }).toString()}`,
      {
        body: {
          Image: options.image,
          ...(options.command ? { Cmd: options.command } : {}),
          Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
          Labels: {
            [DOCKER_MANAGED_LABEL]: '1',
            [LABEL_ID]: spec.sandboxId,
            [LABEL_KIND]: spec.kind,
            [LABEL_DEPLOYMENT]: options.deployment,
          },
          ExposedPorts: { [port]: {} },
          HostConfig: {
            ...(primary ? { NetworkMode: primary } : {}),
            Memory: options.memoryBytes,
            MemorySwap: options.memoryBytes,
            ShmSize: options.shmBytes,
            PidsLimit: options.pidsLimit,
            ...(options.cpus > 0 ? { NanoCpus: Math.round(options.cpus * 1_000_000_000) } : {}),
            ...(options.nestedEngine
              ? { Privileged: true }
              : {
                  SecurityOpt: ['no-new-privileges:true'],
                  CapDrop: ['ALL'],
                  CapAdd: CAPABILITIES,
                }),
            // The orchestrator decides when a sandbox runs; the engine never restarts one.
            RestartPolicy: { Name: 'no' },
            LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
            ...(options.publishHost
              ? { PortBindings: { [port]: [{ HostIp: options.publishHost, HostPort: '' }] } }
              : {}),
          },
          ...(primary ? { NetworkingConfig: { EndpointsConfig: { [primary]: {} } } } : {}),
        },
      }
    );
    if (!ok(created)) throw failure(created);
    const parsed = parseEngineJson(created.body);
    const id = isRecord(parsed) && typeof parsed.Id === 'string' ? parsed.Id : '';
    if (!id) throw new ProviderError('the engine created the container without answering its id');
    try {
      for (const network of others) {
        const joined = await this.engine.call(
          'POST',
          `/networks/${encodeURIComponent(network)}/connect`,
          { body: { Container: id } }
        );
        if (!ok(joined)) throw failure(joined);
      }
      await this.start(id);
    } catch (error) {
      // Nothing half-made is left behind for the next attempt to trip on.
      await this.destroy(id).catch(() => undefined);
      throw error;
    }
    return { providerId: id };
  }

  private async start(id: string): Promise<void> {
    const response = await this.engine.call('POST', `/containers/${encodeURIComponent(id)}/start`);
    // 304: already running.
    if (response.status === 204 || response.status === 304) return;
    throw failure(response);
  }

  private sandboxOf(record: Record<string, unknown>): ProviderSandbox {
    const state = isRecord(record.State) ? record.State : {};
    const config = isRecord(record.Config) ? record.Config : {};
    const labels = isRecord(config.Labels) ? config.Labels : {};
    const providerState = dockerState(state);
    const created = typeof record.Created === 'string' ? new Date(record.Created) : null;
    return {
      providerId: typeof record.Id === 'string' ? record.Id : '',
      state: providerState,
      address: providerState === 'running' ? this.addressOf(record) : null,
      sandboxId: typeof labels[LABEL_ID] === 'string' ? labels[LABEL_ID] : null,
      createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
    };
  }

  private addressOf(record: Record<string, unknown>): string | null {
    const settings = isRecord(record.NetworkSettings) ? record.NetworkSettings : {};
    if (this.options.publishHost) {
      const ports = isRecord(settings.Ports) ? settings.Ports : {};
      const bindings = ports[`${SANDBOX_WORKER_PORT}/tcp`];
      const first = Array.isArray(bindings) ? bindings[0] : null;
      const hostPort = isRecord(first) && typeof first.HostPort === 'string' ? first.HostPort : '';
      return hostPort ? `http://${this.options.publishHost}:${hostPort}` : null;
    }
    const networks = isRecord(settings.Networks) ? settings.Networks : {};
    const endpoint = networks[this.options.networks[0] ?? ''];
    const ip =
      isRecord(endpoint) && typeof endpoint.IPAddress === 'string' ? endpoint.IPAddress : '';
    return ip ? `http://${ip}:${SANDBOX_WORKER_PORT}` : null;
  }

  async inspect(providerId: string): Promise<ProviderSandbox | null> {
    const response = await this.engine.call(
      'GET',
      `/containers/${encodeURIComponent(providerId)}/json`
    );
    if (response.status === 404) return null;
    if (!ok(response)) throw failure(response);
    const parsed = parseEngineJson(response.body);
    if (!isRecord(parsed)) throw new ProviderError('the engine answered an unreadable container');
    return this.sandboxOf(parsed);
  }

  async suspend(providerId: string): Promise<void> {
    const id = encodeURIComponent(providerId);
    if (this.options.suspend === 'pause') {
      const response = await this.engine.call('POST', `/containers/${id}/pause`);
      if (response.status === 204) return;
      // Already paused, or not running at all: suspended either way.
      if (response.status === 409) return;
      throw failure(response);
    }
    const response = await this.engine.call(
      'POST',
      `/containers/${id}/stop?t=${STOP_GRACE_SECONDS}`,
      { timeoutMs: (STOP_GRACE_SECONDS + 15) * 1000 }
    );
    // 304: already stopped.
    if (response.status === 204 || response.status === 304) return;
    throw failure(response);
  }

  async resume(providerId: string): Promise<void> {
    const current = await this.engine.call(
      'GET',
      `/containers/${encodeURIComponent(providerId)}/json`
    );
    if (!ok(current)) throw failure(current);
    const parsed = parseEngineJson(current.body);
    const state = isRecord(parsed) && isRecord(parsed.State) ? parsed.State : {};
    if (state.Paused === true) {
      const response = await this.engine.call(
        'POST',
        `/containers/${encodeURIComponent(providerId)}/unpause`
      );
      if (response.status === 204) return;
      throw failure(response);
    }
    await this.start(providerId);
  }

  async destroy(providerId: string): Promise<void> {
    // v: its anonymous volumes (the image's /data and /workspaces) go with it.
    const response = await this.engine.call(
      'DELETE',
      `/containers/${encodeURIComponent(providerId)}?v=1&force=1`,
      { timeoutMs: 60_000 }
    );
    if (response.status === 204 || response.status === 404) return;
    // 409: a removal is already under way.
    if (response.status === 409 && /already in progress/i.test(engineMessage(response))) return;
    throw failure(response);
  }

  async list(): Promise<ProviderSandbox[]> {
    const filters = JSON.stringify({
      label: [`${DOCKER_MANAGED_LABEL}=1`, `${LABEL_DEPLOYMENT}=${this.options.deployment}`],
    });
    const response = await this.engine.call(
      'GET',
      `/containers/json?${new URLSearchParams({ all: '1', filters }).toString()}`
    );
    if (!ok(response)) throw failure(response);
    const parsed = parseEngineJson(response.body);
    if (!Array.isArray(parsed)) return [];
    const out: ProviderSandbox[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry) || typeof entry.Id !== 'string') continue;
      const labels = isRecord(entry.Labels) ? entry.Labels : {};
      // The list answers a summary: `State` is the status word itself.
      const status = typeof entry.State === 'string' ? entry.State : '';
      out.push({
        providerId: entry.Id,
        state: dockerState({ Status: status }),
        address: null,
        sandboxId: typeof labels[LABEL_ID] === 'string' ? labels[LABEL_ID] : null,
        createdAt: typeof entry.Created === 'number' ? new Date(entry.Created * 1000) : null,
      });
    }
    return out;
  }
}
