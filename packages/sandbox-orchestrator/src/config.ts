/**
 * The orchestrator's configuration, read from the environment: which
 * provider makes sandboxes and with what, the idle rules, and what every
 * sandbox's worker is started with.
 *
 *   SANDBOX_PROVIDER              `docker` (the default) or `azure`.
 *   SANDBOX_DEPLOYMENT            names this deployment among others
 *                                 sharing an engine or a sandbox group,
 *                                 default `renkei`.
 *   SANDBOX_IDLE_SUSPEND_MINUTES  suspend after this long idle, default 15.
 *   SANDBOX_IDLE_DELETE_HOURS     remove after this long idle, default 24.
 *   SANDBOX_TEMPLATE_ENV_<NAME>   becomes <NAME> in every sandbox's
 *                                 worker: its DATABASE_URL (the narrowed
 *                                 sandbox role), its delegate address and
 *                                 key, SANDBOX_ENV_SECRETS_KEY, …
 *
 * Docker (docker-provider.ts):
 *   SANDBOX_IMAGE                 the sandbox image, default `renkei-sandbox:latest`.
 *   SANDBOX_DOCKER_HOST           the engine, default the local socket.
 *   SANDBOX_DOCKER_NETWORKS       comma-separated networks a sandbox joins;
 *                                 its address is read from the first.
 *                                 Default `renkei-sandbox`.
 *   SANDBOX_DOCKER_PUBLISH_HOST   publish each worker's port on this host
 *                                 address instead (`127.0.0.1` for an
 *                                 orchestrator and web app run on the host).
 *   SANDBOX_DOCKER_SUSPEND        `stop` (the default) or `pause`.
 *   SANDBOX_DOCKER_COMMAND        the container's command, as a JSON array.
 *   SANDBOX_DOCKER_NESTED_ENGINE  `1` to run sandboxes privileged, so each can
 *                                 run its own container engine for code project
 *                                 services. A developer's machine only.
 *   SANDBOX_MEMORY_MB / SANDBOX_SHM_MB / SANDBOX_PIDS_LIMIT / SANDBOX_CPUS
 *                                 per-sandbox ceilings: 4096, 1024, 4096,
 *                                 and no CPU ceiling.
 *
 * Azure (azure-provider.ts):
 *   SANDBOX_AZURE_SUBSCRIPTION_ID, SANDBOX_AZURE_RESOURCE_GROUP,
 *   SANDBOX_AZURE_SANDBOX_GROUP, SANDBOX_AZURE_REGION   the sandbox group.
 *   SANDBOX_AZURE_ENDPOINT        the data-plane endpoint, when not the region's own.
 *   SANDBOX_AZURE_DISK_IMAGE      the disk image made from the sandbox image.
 *   SANDBOX_AZURE_CPU / _MEMORY / _DISK   default `2000m`, `4096Mi`, `40Gi`.
 *   SANDBOX_AZURE_SUSPEND_MODE    `Memory` (the default) or `Disk`.
 *   SANDBOX_AZURE_VNET_CONNECTION the group's VNet connection sandboxes use.
 *   SANDBOX_AZURE_PORT_AUTH       `entra` (the default): the worker's port takes
 *                                 a Microsoft Entra token from the identities in
 *                                 SANDBOX_AZURE_ENTRA_ALLOWED. `anonymous`: the
 *                                 sandbox's own key alone.
 *   SANDBOX_AZURE_ENTRA_ALLOWED   comma-separated emails/UPNs allowed to call a
 *                                 worker: this orchestrator's identity.
 *   SANDBOX_AZURE_ALLOWED_CIDRS   comma-separated ranges allowed to call a sandbox.
 */

import {
  AzureSandboxProvider,
  azureIngressToken,
  createAzureSandboxClient,
} from './azure-provider';
import { DockerSandboxProvider } from './docker-provider';
import type { SandboxProvider } from './provider';

type Env = Record<string, string | undefined>;

const TEMPLATE_PREFIX = 'SANDBOX_TEMPLATE_ENV_';

function text(env: Env, name: string, fallback = ''): string {
  return env[name]?.trim() || fallback;
}

function list(env: Env, name: string, fallback: string[] = []): string[] {
  const value = text(env, name);
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = text(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function required(env: Env, name: string): string {
  const value = text(env, name);
  if (!value) throw new Error(`${name} is required for this sandbox provider`);
  return value;
}

/** What every sandbox's worker is started with: each SANDBOX_TEMPLATE_ENV_<NAME> as <NAME>. */
export function templateEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(TEMPLATE_PREFIX) || value === undefined) continue;
    const key = name.slice(TEMPLATE_PREFIX.length);
    if (key) out[key] = value;
  }
  return out;
}

export interface IdleRules {
  idleSuspendMs: number;
  idleDeleteMs: number;
}

export function idleRules(env: Env): IdleRules {
  const idleSuspendMs = positive(env, 'SANDBOX_IDLE_SUSPEND_MINUTES', 15) * 60_000;
  const idleDeleteMs = positive(env, 'SANDBOX_IDLE_DELETE_HOURS', 24) * 60 * 60_000;
  if (idleDeleteMs <= idleSuspendMs) {
    throw new Error('SANDBOX_IDLE_DELETE_HOURS must be longer than SANDBOX_IDLE_SUSPEND_MINUTES');
  }
  return { idleSuspendMs, idleDeleteMs };
}

function dockerCommand(env: Env): string[] | null {
  const raw = text(env, 'SANDBOX_DOCKER_COMMAND');
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === 'string')) {
    throw new Error('SANDBOX_DOCKER_COMMAND must be a JSON array of strings');
  }
  return parsed;
}

export async function providerFromEnv(env: Env): Promise<SandboxProvider> {
  const kind = text(env, 'SANDBOX_PROVIDER', 'docker').toLowerCase();
  const deployment = text(env, 'SANDBOX_DEPLOYMENT', 'renkei');
  if (kind === 'docker') {
    const suspend = text(env, 'SANDBOX_DOCKER_SUSPEND', 'stop').toLowerCase();
    if (suspend !== 'stop' && suspend !== 'pause') {
      throw new Error('SANDBOX_DOCKER_SUSPEND must be stop or pause');
    }
    const publishHost = text(env, 'SANDBOX_DOCKER_PUBLISH_HOST') || null;
    return new DockerSandboxProvider({
      image: text(env, 'SANDBOX_IMAGE', 'renkei-sandbox:latest'),
      networks: list(env, 'SANDBOX_DOCKER_NETWORKS', publishHost ? [] : ['renkei-sandbox']),
      publishHost,
      command: dockerCommand(env),
      memoryBytes: positive(env, 'SANDBOX_MEMORY_MB', 4096) * 1_048_576,
      shmBytes: positive(env, 'SANDBOX_SHM_MB', 1024) * 1_048_576,
      pidsLimit: positive(env, 'SANDBOX_PIDS_LIMIT', 4096),
      cpus: text(env, 'SANDBOX_CPUS') ? positive(env, 'SANDBOX_CPUS', 1) : 0,
      suspend,
      nestedEngine: text(env, 'SANDBOX_DOCKER_NESTED_ENGINE') === '1',
      deployment,
      host: text(env, 'SANDBOX_DOCKER_HOST') || undefined,
    });
  }
  if (kind === 'azure') {
    const mode = text(env, 'SANDBOX_AZURE_SUSPEND_MODE', 'Memory').toLowerCase();
    if (mode !== 'memory' && mode !== 'disk') {
      throw new Error('SANDBOX_AZURE_SUSPEND_MODE must be Memory or Disk');
    }
    const client = await createAzureSandboxClient({
      subscriptionId: required(env, 'SANDBOX_AZURE_SUBSCRIPTION_ID'),
      resourceGroup: required(env, 'SANDBOX_AZURE_RESOURCE_GROUP'),
      sandboxGroup: required(env, 'SANDBOX_AZURE_SANDBOX_GROUP'),
      region: required(env, 'SANDBOX_AZURE_REGION'),
      endpoint: text(env, 'SANDBOX_AZURE_ENDPOINT') || null,
    });
    const portAuth = text(env, 'SANDBOX_AZURE_PORT_AUTH', 'entra').toLowerCase();
    if (portAuth !== 'entra' && portAuth !== 'anonymous') {
      throw new Error('SANDBOX_AZURE_PORT_AUTH must be entra or anonymous');
    }
    const entraAllowed = list(env, 'SANDBOX_AZURE_ENTRA_ALLOWED');
    if (portAuth === 'entra' && entraAllowed.length === 0) {
      // An empty list means everyone in the tenant, which is not what a worker's port is for.
      throw new Error(
        'SANDBOX_AZURE_ENTRA_ALLOWED is required with Entra on the worker port: the identity this orchestrator calls sandboxes as'
      );
    }
    return new AzureSandboxProvider({
      portAuth,
      entraAllowed,
      ingressToken: azureIngressToken,
      diskImage: required(env, 'SANDBOX_AZURE_DISK_IMAGE'),
      cpu: text(env, 'SANDBOX_AZURE_CPU', '2000m'),
      memory: text(env, 'SANDBOX_AZURE_MEMORY', '4096Mi'),
      disk: text(env, 'SANDBOX_AZURE_DISK', '40Gi'),
      suspendMode: mode === 'memory' ? 'Memory' : 'Disk',
      vnetConnection: text(env, 'SANDBOX_AZURE_VNET_CONNECTION') || null,
      allowedCidrs: list(env, 'SANDBOX_AZURE_ALLOWED_CIDRS'),
      deployment,
      client,
    });
  }
  throw new Error(`SANDBOX_PROVIDER must be docker or azure, got ${JSON.stringify(kind)}`);
}
