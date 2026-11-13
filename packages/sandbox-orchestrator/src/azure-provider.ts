/**
 * Sandboxes as Azure Container Apps sandboxes: a microVM per sandbox in
 * one sandbox group (`Microsoft.App/sandboxGroups`), made from a disk
 * image built from the sandbox's OCI image.
 * https://learn.microsoft.com/azure/container-apps/sandboxes-overview
 *
 * The orchestrator's identity (a managed identity in production,
 * `az login` on a workstation — `DefaultAzureCredential`) needs the
 * "Container Apps SandboxGroup Data Owner" role on the group. Everything
 * here is the group's data plane, through `@azure/containerapps-sandbox`
 * (a preview SDK: pinned exactly, and held behind `AzureSandboxClient`
 * so a change in it lands in this file alone).
 *
 * What the platform does that the Docker provider only imitates:
 *  - suspend keeps memory as well as disk (`suspendMode: 'Memory'`), so
 *    a kernel or a dev server is still there on resume;
 *  - the group's egress proxy and VNet connection decide what a sandbox
 *    reaches (`vnetConnection`: the database and the delegate, on a
 *    private network);
 *  - the lifecycle policy enforces the idle rules by itself. It is set
 *    as a BACKSTOP, at twice the orchestrator's own intervals: the
 *    orchestrator suspends and deletes on its schedule and records it;
 *    the platform only acts if the orchestrator is away. Either way a
 *    sandbox the platform stopped or removed is noticed on the next call
 *    (the orchestrator asks before trusting a row it has not checked
 *    lately).
 *
 * The worker's port is exposed with the platform's HTTPS ingress and
 * anonymous access: the worker's own per-sandbox bearer key (keys.ts) is
 * what authenticates a call, as it does on Docker. A deployment that
 * wants the port unreachable from the internet restricts it by source
 * address (`allowedCidrs`) or puts a private endpoint in front of the
 * group.
 */

import {
  ProviderError,
  SANDBOX_WORKER_PORT,
  type ProviderSandbox,
  type ProviderSandboxState,
  type SandboxProvider,
  type SandboxSpec,
} from './provider';

export const AZURE_MANAGED_LABEL = 'renkei-orchestrator';
const LABEL_ID = 'renkei-sandbox-id';
const LABEL_KIND = 'renkei-kind';

/** The sandbox as the SDK answers it — only what is read here. */
export interface AzureSandbox {
  id: string;
  state?: string;
  labels?: Record<string, string>;
  ports?: Array<{ port: number; url?: string }>;
  createdAt?: string;
}

interface Poller<T> {
  pollUntilDone(): Promise<T>;
}

/** The part of `SandboxGroupClient.sandboxes` this provider calls. */
export interface AzureSandboxClient {
  get(sandboxId: string): Promise<AzureSandbox>;
  list(options?: { labels?: Record<string, string> }): AsyncIterable<AzureSandbox>;
  beginCreate(body: Record<string, unknown>): Poller<AzureSandbox>;
  delete(sandboxId: string): Promise<void>;
  beginStop(sandboxId: string): Poller<unknown>;
  beginResume(sandboxId: string): Poller<unknown>;
}

export interface AzureProviderOptions {
  /** The disk image sandboxes boot from: the sandbox OCI image, imported into the group. */
  diskImage: string;
  /** Whether `diskImage` names one of Microsoft's public images rather than the group's own. */
  diskImagePublic?: boolean;
  /** e.g. `2000m`, `4096Mi`, `40Gi`. */
  cpu: string;
  memory: string;
  disk: string;
  suspendMode: 'Memory' | 'Disk';
  /** The group's VNet connection sandboxes use to reach private resources; none when unset. */
  vnetConnection?: string | null;
  /** Source ranges allowed to call the worker's port; anyone (with the bearer key) when empty. */
  allowedCidrs?: string[];
  /** Names this deployment among others sharing a sandbox group. */
  deployment: string;
  client: AzureSandboxClient;
}

/** The platform's state word in the orchestrator's vocabulary; null for one that is going away. */
export function azureState(state: string | undefined): ProviderSandboxState | null {
  switch ((state ?? '').toLowerCase()) {
    case 'running':
    case 'idle':
      return 'running';
    case 'creating':
    case 'resuming':
    case 'starting':
      return 'starting';
    case 'stopping':
    case 'suspending':
      return 'stopping';
    case 'stopped':
    case 'suspended':
      return 'suspended';
    case 'deleting':
    case 'deleted':
      return null;
    default:
      // Disabled, Failed, or a word this build has not met: it will not run for us.
      return 'failed';
  }
}

function statusOf(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : 0;
}

function wrap(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(error instanceof Error ? error.message : String(error), statusOf(error));
}

export class AzureSandboxProvider implements SandboxProvider {
  readonly name = 'azure';

  constructor(private readonly options: AzureProviderOptions) {}

  private get client(): AzureSandboxClient {
    return this.options.client;
  }

  private sandboxOf(sandbox: AzureSandbox): ProviderSandbox | null {
    const state = azureState(sandbox.state);
    if (state === null) return null;
    const url = sandbox.ports?.find((port) => port.port === SANDBOX_WORKER_PORT)?.url;
    const created = sandbox.createdAt ? new Date(sandbox.createdAt) : null;
    return {
      providerId: sandbox.id,
      state,
      address: state === 'running' && url ? url.replace(/\/+$/, '') : null,
      sandboxId: sandbox.labels?.[LABEL_ID] ?? null,
      createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
    };
  }

  async check(): Promise<void> {
    try {
      // One page of the group's sandboxes: the credential, the role and the group, in one call.
      for await (const _sandbox of this.client.list({
        labels: { [AZURE_MANAGED_LABEL]: this.options.deployment },
      })) {
        break;
      }
    } catch (error) {
      throw wrap(error);
    }
  }

  async create(spec: SandboxSpec): Promise<{ providerId: string }> {
    const { options } = this;
    const cidrs = options.allowedCidrs ?? [];
    try {
      const sandbox = await this.client
        .beginCreate({
          sourcesRef: {
            diskImage: { name: options.diskImage, isPublic: options.diskImagePublic === true },
          },
          resources: { cpu: options.cpu, memory: options.memory, disk: options.disk },
          lifecycle: {
            autoSuspend: {
              enabled: true,
              interval: spec.idleSuspendSeconds * 2,
              mode: options.suspendMode,
            },
            autoDelete: { enabled: true, deleteIntervalSeconds: spec.idleDeleteSeconds * 2 },
          },
          labels: {
            [AZURE_MANAGED_LABEL]: options.deployment,
            [LABEL_ID]: spec.sandboxId,
            [LABEL_KIND]: spec.kind,
          },
          environment: spec.env,
          ports: [
            {
              port: SANDBOX_WORKER_PORT,
              auth: { anonymous: true },
              protocol: 'Http',
              ...(cidrs.length > 0
                ? {
                    ipAccessControl: {
                      defaultAction: 'Deny',
                      rules: [
                        { name: 'callers', action: 'Allow', priority: 100, sourceCidrs: cidrs },
                      ],
                    },
                  }
                : {}),
            },
          ],
          ...(options.vnetConnection
            ? { customerVnetConnectionName: options.vnetConnection }
            : {}),
        })
        .pollUntilDone();
      return { providerId: sandbox.id };
    } catch (error) {
      throw wrap(error);
    }
  }

  async inspect(providerId: string): Promise<ProviderSandbox | null> {
    try {
      return this.sandboxOf(await this.client.get(providerId));
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw wrap(error);
    }
  }

  async suspend(providerId: string): Promise<void> {
    try {
      await this.client.beginStop(providerId).pollUntilDone();
    } catch (error) {
      // Already stopped is what was asked for.
      const now = await this.inspect(providerId).catch(() => null);
      if (now?.state === 'suspended') return;
      throw wrap(error);
    }
  }

  async resume(providerId: string): Promise<void> {
    try {
      await this.client.beginResume(providerId).pollUntilDone();
    } catch (error) {
      const now = await this.inspect(providerId).catch(() => null);
      if (now?.state === 'running' || now?.state === 'starting') return;
      throw wrap(error);
    }
  }

  async destroy(providerId: string): Promise<void> {
    try {
      await this.client.delete(providerId);
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw wrap(error);
    }
  }

  async list(): Promise<ProviderSandbox[]> {
    const out: ProviderSandbox[] = [];
    try {
      for await (const sandbox of this.client.list({
        labels: { [AZURE_MANAGED_LABEL]: this.options.deployment },
      })) {
        const found = this.sandboxOf(sandbox);
        if (found) out.push(found);
      }
    } catch (error) {
      throw wrap(error);
    }
    return out;
  }
}

export interface AzureClientConfig {
  subscriptionId: string;
  resourceGroup: string;
  sandboxGroup: string;
  /** The group's region, e.g. `eastus2`; names the data-plane endpoint. */
  region: string;
  /** The data-plane endpoint itself, when it is not the region's default. */
  endpoint?: string | null;
}

/**
 * The real client: the SDK and the identity library, loaded only here so
 * a Docker deployment never loads either.
 */
export async function createAzureSandboxClient(
  config: AzureClientConfig
): Promise<AzureSandboxClient> {
  const [{ SandboxGroupClient, endpointForRegion }, { DefaultAzureCredential }] =
    await Promise.all([import('@azure/containerapps-sandbox'), import('@azure/identity')]);
  const group = new SandboxGroupClient(
    new DefaultAzureCredential(),
    config.endpoint || endpointForRegion(config.region),
    config.subscriptionId,
    config.resourceGroup,
    config.sandboxGroup
  );
  const { sandboxes } = group;
  return {
    get: (id) => sandboxes.get(id),
    list: (options) => sandboxes.list(options),
    // The body is built in this file against the SDK's CreateSandboxRequest.
    beginCreate: (body) => sandboxes.beginCreate(body as Parameters<typeof sandboxes.beginCreate>[0]),
    delete: (id) => sandboxes.delete(id),
    beginStop: (id) => sandboxes.beginStop(id),
    beginResume: (id) => sandboxes.beginResume(id),
  };
}
