/**
 * The sandbox orchestrator's configuration, as the organization keeps it:
 * one row in `connector_configs` (`sandbox-orchestrator`), its secrets
 * sealed with the deployment key like every connector's
 * (docs/sandbox-orchestrator-design.md). An operator edits it on
 * Organization → Sandboxes; the orchestrator reads it and makes sandboxes
 * accordingly, and picks a change up without a restart.
 *
 * What is a setting and what is a secret:
 *
 *  - settings (stored as they are): which provider makes sandboxes and
 *    where — the Azure sandbox group, or the Docker engine — the size of
 *    a sandbox, the idle rules, and the NAMES of the variables every
 *    sandbox's worker is started with;
 *  - secrets (sealed): the Azure service principal's client secret, and
 *    the VALUES of those variables (a database URL, a delegate key). A
 *    secret is write-only: the page shows that one is stored, never what
 *    it is, and a blank field keeps it.
 *
 * This module is the one description of a valid configuration: the admin
 * routes parse a submitted form with it, and the orchestrator reads the
 * stored row with it, so the two cannot disagree. It is pure — no
 * database, no provider — and holds no defaults that only one side knows.
 */

import { isRecord } from '@renkei/guards';

/** The connector_configs key. */
export const SANDBOX_ORCHESTRATOR_CONNECTOR = 'sandbox-orchestrator';

export type SandboxProviderKind = 'azure' | 'docker';

export interface AzureSandboxSettings {
  subscriptionId: string;
  resourceGroup: string;
  sandboxGroup: string;
  /** The group's region, e.g. `eastus2`. */
  region: string;
  /** The data-plane endpoint, when it is not the region's own. */
  endpoint: string | null;
  /** The disk image sandboxes boot from: the sandbox image, imported into the group. */
  diskImage: string;
  cpu: string;
  memory: string;
  disk: string;
  suspendMode: 'Memory' | 'Disk';
  /** The group's VNet connection sandboxes reach private resources through. */
  vnetConnection: string | null;
  /** How the worker's port is guarded: Microsoft Entra, or the sandbox's own key alone. */
  portAuth: 'entra' | 'anonymous';
  /** With Entra: the identities (emails or UPNs) allowed to call a worker. */
  entraAllowed: string[];
  /** Source ranges allowed to call a worker; any when empty. */
  allowedCidrs: string[];
  /**
   * The service principal the orchestrator signs in as. Both blank: the
   * orchestrator's own managed identity.
   */
  tenantId: string | null;
  clientId: string | null;
}

export interface DockerSandboxSettings {
  image: string;
  /** The engine; blank is the local socket. */
  host: string | null;
  /** Networks a sandbox joins; its address is read from the first. */
  networks: string[];
  /** Publish each worker's port on this host address instead. */
  publishHost: string | null;
  suspend: 'stop' | 'pause';
  /** Privileged sandboxes, so each can run its own container engine. A developer's machine only. */
  nestedEngine: boolean;
  memoryMb: number;
  /** 0 for no ceiling. */
  cpus: number;
  /** The container's command, when the image's own is not wanted. */
  command: string[] | null;
}

export interface SandboxOrchestratorSettings {
  provider: SandboxProviderKind;
  idleSuspendMinutes: number;
  idleEvictHours: number;
  azure: AzureSandboxSettings;
  docker: DockerSandboxSettings;
  /** The variables every sandbox's worker is started with; values are secrets. */
  envNames: string[];
}

/** The secret a variable's value is stored under. */
export function envSecretKey(name: string): string {
  return `env.${name}`;
}

export const AZURE_CLIENT_SECRET_KEY = 'azureClientSecret';

export const DEFAULT_ORCHESTRATOR_SETTINGS: SandboxOrchestratorSettings = {
  provider: 'azure',
  idleSuspendMinutes: 15,
  idleEvictHours: 24,
  azure: {
    subscriptionId: '',
    resourceGroup: '',
    sandboxGroup: '',
    region: '',
    endpoint: null,
    diskImage: '',
    cpu: '2000m',
    memory: '4096Mi',
    disk: '40Gi',
    suspendMode: 'Memory',
    vnetConnection: null,
    portAuth: 'entra',
    entraAllowed: [],
    allowedCidrs: [],
    tenantId: null,
    clientId: null,
  },
  docker: {
    image: 'renkei-sandbox:latest',
    host: null,
    networks: ['renkei-sandbox'],
    publishHost: null,
    suspend: 'stop',
    nestedEngine: false,
    memoryMb: 4096,
    cpus: 0,
    command: null,
  },
  envNames: [],
};

/**
 * Variables a sandbox is never started with from here: the ones the
 * orchestrator sets itself for each sandbox, and the organization's own
 * encryption keys, which no sandbox may hold.
 */
const RESERVED_ENV = new Set([
  'SANDBOX_WORKER_API_KEY',
  'SANDBOX_WORKER_PORT',
  'SANDBOX_ORCHESTRATED',
  'SANDBOX_INSTANCE_ID',
  'TOKEN_ENCRYPTION_KEY',
  'TOKEN_ENCRYPTION_KEYS',
  'CONTENT_ENCRYPTION_KEY',
  'CONTENT_ENCRYPTION_KEYS',
  'USER_KEY_ENCRYPTION_KEY',
  'DELEGATE_INSTANCE_KEY',
  'SANDBOX_ORCHESTRATOR_API_KEY',
]);

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AZURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/;
const REGION = /^[a-z0-9]{3,40}$/;
const CPU = /^\d{2,6}m$/;
const SIZE = /^\d{1,6}(Mi|Gi)$/;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IDENTITY = /^[^\s@,]+@[^\s@,]+$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map(text)
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(text(value));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** The settings of a stored row, with defaults for whatever it does not say. Never throws. */
export function orchestratorSettingsOfRow(
  settings: Record<string, unknown>
): SandboxOrchestratorSettings {
  const d = DEFAULT_ORCHESTRATOR_SETTINGS;
  const azure = isRecord(settings.azure) ? settings.azure : {};
  const docker = isRecord(settings.docker) ? settings.docker : {};
  const orNull = (value: unknown): string | null => text(value) || null;
  const command = Array.isArray(docker.command) ? docker.command.map(text).filter(Boolean) : [];
  return {
    provider: settings.provider === 'docker' ? 'docker' : 'azure',
    idleSuspendMinutes: numberIn(settings.idleSuspendMinutes, 15, 1, 1_440) ?? 15,
    idleEvictHours: numberIn(settings.idleEvictHours, 24, 1, 8_760) ?? 24,
    azure: {
      subscriptionId: text(azure.subscriptionId),
      resourceGroup: text(azure.resourceGroup),
      sandboxGroup: text(azure.sandboxGroup),
      region: text(azure.region),
      endpoint: orNull(azure.endpoint),
      diskImage: text(azure.diskImage),
      cpu: text(azure.cpu) || d.azure.cpu,
      memory: text(azure.memory) || d.azure.memory,
      disk: text(azure.disk) || d.azure.disk,
      suspendMode: azure.suspendMode === 'Disk' ? 'Disk' : 'Memory',
      vnetConnection: orNull(azure.vnetConnection),
      portAuth: azure.portAuth === 'anonymous' ? 'anonymous' : 'entra',
      entraAllowed: list(azure.entraAllowed),
      allowedCidrs: list(azure.allowedCidrs),
      tenantId: orNull(azure.tenantId),
      clientId: orNull(azure.clientId),
    },
    docker: {
      image: text(docker.image) || d.docker.image,
      host: orNull(docker.host),
      networks: Array.isArray(docker.networks) ? list(docker.networks) : d.docker.networks,
      publishHost: orNull(docker.publishHost),
      suspend: docker.suspend === 'pause' ? 'pause' : 'stop',
      nestedEngine: docker.nestedEngine === true,
      memoryMb: numberIn(docker.memoryMb, d.docker.memoryMb, 64, 262_144) ?? d.docker.memoryMb,
      cpus: numberIn(docker.cpus, 0, 0, 256) ?? 0,
      command: command.length > 0 ? command : null,
    },
    envNames: list(settings.envNames).filter((name) => ENV_NAME.test(name)),
  };
}

/** What a submitted form asks to be stored. */
export interface OrchestratorInput {
  enabled: boolean;
  settings: SandboxOrchestratorSettings;
  /** The client secret typed; null keeps the stored one. */
  azureClientSecret: string | null;
  /** Each variable's value as typed; a name absent here keeps its stored value. */
  envValues: Record<string, string>;
}

/**
 * A submitted form, checked: the input to store, or one sentence saying
 * what is wrong. Only the chosen provider's fields are required to be
 * complete; the other's are kept as they came.
 */
export function parseOrchestratorInput(body: unknown): OrchestratorInput | string {
  if (!isRecord(body)) return 'JSON body required';
  const settings = orchestratorSettingsOfRow(body);
  if (body.provider !== 'azure' && body.provider !== 'docker') {
    return 'Choose where sandboxes are made: Azure or Docker.';
  }
  const suspend = numberIn(body.idleSuspendMinutes, 15, 1, 1_440);
  if (suspend === null) return 'Suspend after 1 to 1440 idle minutes.';
  const evict = numberIn(body.idleEvictHours, 24, 1, 8_760);
  if (evict === null) return 'Evict after 1 to 8760 idle hours.';
  if (evict * 60 <= suspend) return 'A sandbox must be evicted later than it is suspended.';

  if (settings.provider === 'azure') {
    const azure = settings.azure;
    if (!UUID.test(azure.subscriptionId)) return 'The subscription id is a GUID.';
    if (!AZURE_NAME.test(azure.resourceGroup)) return 'Enter the resource group’s name.';
    if (!AZURE_NAME.test(azure.sandboxGroup)) return 'Enter the sandbox group’s name.';
    if (!REGION.test(azure.region)) {
      return 'The region is its short name in lowercase, such as eastus2.';
    }
    if (azure.endpoint && !/^https:\/\/[^\s/]+/.test(azure.endpoint)) {
      return 'The endpoint must be an https URL.';
    }
    if (!AZURE_NAME.test(azure.diskImage)) return 'Enter the disk image sandboxes start from.';
    if (!CPU.test(azure.cpu)) return 'CPU is in millicores, such as 2000m.';
    if (!SIZE.test(azure.memory)) return 'Memory is a size such as 4096Mi or 4Gi.';
    if (!SIZE.test(azure.disk)) return 'Disk is a size such as 40Gi.';
    if (azure.vnetConnection && !AZURE_NAME.test(azure.vnetConnection)) {
      return 'The VNet connection is the name the sandbox group gives it.';
    }
    if (azure.entraAllowed.some((identity) => !IDENTITY.test(identity))) {
      return 'Each allowed identity is an email address or a user principal name.';
    }
    if (azure.portAuth === 'entra' && azure.entraAllowed.length === 0) {
      // An empty list means everyone in the directory.
      return 'With Microsoft Entra on the worker port, name the identity the orchestrator calls sandboxes as.';
    }
    if (azure.allowedCidrs.some((range) => !CIDR.test(range))) {
      return 'Each allowed range is an IPv4 CIDR, such as 10.0.0.0/8.';
    }
    if (Boolean(azure.tenantId) !== Boolean(azure.clientId)) {
      return 'A service principal needs both its tenant id and its client id; leave both blank to use the orchestrator’s managed identity.';
    }
    if (azure.tenantId && !UUID.test(azure.tenantId)) return 'The tenant id is a GUID.';
    if (azure.clientId && !UUID.test(azure.clientId)) return 'The client id is a GUID.';
  } else {
    const docker = settings.docker;
    if (!/^[^\s]+$/.test(docker.image)) return 'Enter the sandbox image.';
    if (docker.host && !/^(unix:\/\/\/|tcp:\/\/|http:\/\/|\/)/.test(docker.host)) {
      return 'The engine is a socket path, unix:///…, or tcp://host:port.';
    }
    if (docker.networks.length === 0 && !docker.publishHost) {
      return 'Name a network sandboxes join, or a host address their ports are published on.';
    }
    if (
      numberIn(isRecord(body.docker) ? body.docker.memoryMb : undefined, 4096, 64, 262_144) === null
    ) {
      return 'A sandbox’s memory is 64 to 262144 MB.';
    }
  }

  const rawNames = list(body.envNames);
  for (const name of rawNames) {
    if (!ENV_NAME.test(name)) {
      return `"${name}" is not a variable name: capitals, digits and underscores.`;
    }
    if (RESERVED_ENV.has(name)) {
      return `${name} cannot be handed to a sandbox: it is the orchestrator’s to set, or one of the organization’s own keys.`;
    }
  }
  const envValues: Record<string, string> = {};
  if (isRecord(body.envValues)) {
    for (const name of rawNames) {
      const value = body.envValues[name];
      if (typeof value === 'string' && value !== '') envValues[name] = value;
    }
  }
  const secret = typeof body.azureClientSecret === 'string' ? body.azureClientSecret : '';
  return {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
    settings: {
      ...settings,
      idleSuspendMinutes: suspend,
      idleEvictHours: evict,
      envNames: rawNames,
    },
    azureClientSecret: secret || null,
    envValues,
  };
}

/**
 * The secrets to store for an input, laid over the ones already stored:
 * a typed value replaces, a blank keeps, and a variable no longer named
 * is dropped. Answers a sentence when something required is missing.
 */
export function mergeOrchestratorSecrets(
  input: OrchestratorInput,
  stored: Record<string, string>
): Record<string, string> | string {
  const secrets: Record<string, string> = {};
  const clientSecret = input.azureClientSecret ?? stored[AZURE_CLIENT_SECRET_KEY];
  if (clientSecret) secrets[AZURE_CLIENT_SECRET_KEY] = clientSecret;
  if (
    input.settings.provider === 'azure' &&
    input.settings.azure.clientId &&
    !secrets[AZURE_CLIENT_SECRET_KEY]
  ) {
    return 'Enter the service principal’s client secret.';
  }
  for (const name of input.settings.envNames) {
    const value = input.envValues[name] ?? stored[envSecretKey(name)];
    if (!value) return `Enter a value for ${name}.`;
    secrets[envSecretKey(name)] = value;
  }
  return secrets;
}

/** What every sandbox's worker is started with, from a stored row. */
export function orchestratorTemplateEnv(
  settings: SandboxOrchestratorSettings,
  secrets: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of settings.envNames) {
    const value = secrets[envSecretKey(name)];
    if (value !== undefined && !RESERVED_ENV.has(name)) env[name] = value;
  }
  return env;
}

/** The configuration as the admin page shows it: every setting, and which secrets are stored. */
export interface OrchestratorView {
  configured: boolean;
  enabled: boolean;
  settings: SandboxOrchestratorSettings;
  hasAzureClientSecret: boolean;
  /** The variables whose values are stored. */
  envStored: string[];
}

export function orchestratorViewOfRow(
  row: {
    enabled: boolean;
    settings: Record<string, unknown>;
    secrets: Record<string, string>;
  } | null
): OrchestratorView {
  if (!row) {
    return {
      configured: false,
      enabled: false,
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      hasAzureClientSecret: false,
      envStored: [],
    };
  }
  const settings = orchestratorSettingsOfRow(row.settings);
  return {
    configured: true,
    enabled: row.enabled,
    settings,
    hasAzureClientSecret: Boolean(row.secrets[AZURE_CLIENT_SECRET_KEY]),
    envStored: settings.envNames.filter((name) => Boolean(row.secrets[envSecretKey(name)])),
  };
}
