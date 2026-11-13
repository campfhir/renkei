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
 *  - the lifecycle policy suspends an idle sandbox by itself. It is set
 *    as a BACKSTOP, at twice the orchestrator's own interval: the
 *    orchestrator suspends on its schedule and records it; the platform
 *    only acts if the orchestrator is away. A sandbox the platform
 *    stopped is noticed on the next call (the orchestrator asks before
 *    trusting a row it has not checked lately). The platform's
 *    auto-delete is OFF: a sandbox is removed only by the orchestrator,
 *    once what it holds is archived.
 *
 * Who may call a sandbox is Microsoft Entra's to say, enforced by the
 * platform's ingress outside the sandbox (`portAuth: 'entra'`, the
 * default):
 *
 *  - The WORKER's port takes a bearer token for the ingress
 *    (`https://auth.adcproxy.io`) from the identities allowed on it
 *    (`entraAllowed`: the orchestrator's and the web app's service
 *    identity). The orchestrator gets that token as itself and hands it
 *    to callers with the sandbox's address (`callerHeaders`). The ingress
 *    strips `authorization` before the request reaches the sandbox, so
 *    the worker's own per-sandbox key — still checked, as a second lock
 *    — rides `x-sandbox-key`.
 *  - A PREVIEW port (`exposePort`) is opened to named people, who sign
 *    in to it in their own browsers as themselves.
 *
 * `portAuth: 'anonymous'` leaves the worker's port to the per-sandbox key
 * alone, optionally narrowed by source address (`allowedCidrs`).
 *
 * Preview-SDK limits as of 1.0.0-beta.1, to check on first contact: the
 * SDK sets allowed EMAILS (UPNs) only — a port's tenant id and allowed
 * object ids are set in the portal — and Microsoft's documentation
 * describes allowing users, not service principals.
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

/** A port's guard, as the SDK reads and writes it. */
export interface AzurePortAuth {
  anonymous?: boolean;
  entraId?: { enabled: boolean; emails: string[] };
}

/** A port as the SDK answers it; everything but `url` is sent back when the ports are set. */
export interface AzurePort {
  port: number;
  url?: string;
  auth?: AzurePortAuth;
  protocol?: 'Http' | 'Http2';
  ipAccessControl?: {
    defaultAction: 'Allow' | 'Deny';
    rules: Array<{
      name: string;
      action: 'Allow' | 'Deny';
      priority: number;
      sourceCidrs: string[];
    }>;
  };
}

/** The sandbox as the SDK answers it — only what is read here. */
export interface AzureSandbox {
  id: string;
  state?: string;
  labels?: Record<string, string>;
  ports?: AzurePort[];
  createdAt?: string;
}

/** What a sandbox is created with — the fields of the SDK's CreateSandboxRequest this provider sets. */
export interface AzureCreateRequest {
  sourcesRef: { diskImage: { name: string; isPublic: boolean } };
  resources: { cpu: string; memory: string; disk: string };
  lifecycle: {
    autoSuspend: { enabled: boolean; interval: number; mode: 'Memory' | 'Disk' };
    autoDelete: { enabled: boolean };
  };
  labels: Record<string, string>;
  environment: Record<string, string>;
  ports: Array<{
    port: number;
    auth: { anonymous: boolean } | { entraId: { enabled: boolean; emails: string[] } };
    protocol: 'Http';
    ipAccessControl?: {
      defaultAction: 'Deny';
      rules: Array<{ name: string; action: 'Allow'; priority: number; sourceCidrs: string[] }>;
    };
  }>;
  customerVnetConnectionName?: string;
}

interface Poller<T> {
  pollUntilDone(): Promise<T>;
}

/** The part of `SandboxGroupClient.sandboxes` this provider calls. */
export interface AzureSandboxClient {
  get(sandboxId: string): Promise<AzureSandbox>;
  list(options?: { labels?: Record<string, string> }): AsyncIterable<AzureSandbox>;
  beginCreate(body: AzureCreateRequest): Poller<AzureSandbox>;
  delete(sandboxId: string): Promise<void>;
  /** Set the sandbox's ports to exactly these (the SDK's bulk update replaces them all). */
  updatePorts(sandboxId: string, ports: AzurePort[]): Promise<AzurePort[]>;
  removePort(sandboxId: string, port: number): Promise<void>;
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
  /** How the worker's port is guarded by the platform; Entra unless told otherwise. */
  portAuth?: 'entra' | 'anonymous';
  /** With Entra: the identities (emails or UPNs) allowed to call the worker's port. */
  entraAllowed?: string[];
  /**
   * With Entra: a token for the platform's ingress, as this process's
   * own identity. Remembered until shortly before it expires.
   */
  ingressToken?: () => Promise<{ token: string; expiresOnTimestamp: number }>;
  /** Source ranges allowed to call the worker's port; anyone otherwise let in when empty. */
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
  if (!(error instanceof Error) || !('statusCode' in error)) return 0;
  return typeof error.statusCode === 'number' ? error.statusCode : 0;
}

function wrap(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(error instanceof Error ? error.message : String(error), statusOf(error));
}

/** The audience of the token the platform's ingress takes on a port guarded by Entra. */
export const AZURE_INGRESS_SCOPE = 'https://auth.adcproxy.io/.default';
/** A token this close to expiring is replaced rather than handed out. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export class AzureSandboxProvider implements SandboxProvider {
  readonly name = 'azure';
  private token: { token: string; expiresOnTimestamp: number } | null = null;

  constructor(private readonly options: AzureProviderOptions) {
    if (this.entra && !options.ingressToken) {
      throw new Error('Entra on the worker port needs a way to get an ingress token');
    }
  }

  private get entra(): boolean {
    return (this.options.portAuth ?? 'entra') === 'entra';
  }

  async callerHeaders(): Promise<Record<string, string>> {
    if (!this.entra || !this.options.ingressToken) return {};
    if (!this.token || this.token.expiresOnTimestamp - Date.now() < TOKEN_MARGIN_MS) {
      try {
        this.token = await this.options.ingressToken();
      } catch (error) {
        throw wrap(error);
      }
    }
    return { authorization: `Bearer ${this.token.token}` };
  }

  async exposePort(
    providerId: string,
    port: number,
    access: { emails: string[] }
  ): Promise<{ url: string }> {
    try {
      // One call can name one person; several need the bulk update, which
      // replaces every port — so the ports there are (the worker's among
      // them) are sent back as they stand, with this one added.
      const current = (await this.client.get(providerId)).ports ?? [];
      const kept = current
        .filter((existing) => existing.port !== port)
        .map(({ url: _url, ...rest }) => rest);
      // Whoever was let in already stays: each person is added as they
      // open it, and the list empties when the port is closed.
      const already =
        current.find((existing) => existing.port === port)?.auth?.entraId?.emails ?? [];
      const emails = [
        ...new Set([...already, ...access.emails].map((email) => email.toLowerCase())),
      ];
      const ports = await this.client.updatePorts(providerId, [
        ...kept,
        { port, protocol: 'Http', auth: { entraId: { enabled: true, emails } } },
      ]);
      const url = ports.find((opened) => opened.port === port)?.url;
      if (!url) throw new ProviderError('the platform opened the port without an address');
      return { url: url.replace(/\/+$/, '') };
    } catch (error) {
      throw wrap(error);
    }
  }

  async unexposePort(providerId: string, port: number): Promise<void> {
    try {
      await this.client.removePort(providerId, port);
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw wrap(error);
    }
  }

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
            // Never by the platform: removal is the orchestrator's, after an archive.
            autoDelete: { enabled: false },
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
              auth: this.entra
                ? { entraId: { enabled: true, emails: options.entraAllowed ?? [] } }
                : { anonymous: true },
              protocol: 'Http' as const,
              ...(cidrs.length > 0
                ? {
                    ipAccessControl: {
                      defaultAction: 'Deny' as const,
                      rules: [
                        {
                          name: 'callers',
                          action: 'Allow' as const,
                          priority: 100,
                          sourceCidrs: cidrs,
                        },
                      ],
                    },
                  }
                : {}),
            },
          ],
          ...(options.vnetConnection ? { customerVnetConnectionName: options.vnetConnection } : {}),
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
/**
 * Who the orchestrator signs in to Azure as: a service principal when
 * one is given (the organization's stored configuration), else this
 * process's own identity — a managed identity where it runs in Azure.
 */
export interface AzureIdentity {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

async function credentialFor(identity: AzureIdentity | null | undefined, staticToken?: string) {
  if (staticToken) {
    // A token got elsewhere (`az account get-access-token`), for a one-off
    // run where no identity is set up: good until it expires.
    return {
      getToken: async () => ({ token: staticToken, expiresOnTimestamp: Date.now() + 3_000_000 }),
    };
  }
  const { ClientSecretCredential, DefaultAzureCredential } = await import('@azure/identity');
  return identity
    ? new ClientSecretCredential(identity.tenantId, identity.clientId, identity.clientSecret)
    : new DefaultAzureCredential();
}

/** A way to get tokens for the platform's ingress as that identity. */
export function azureIngressToken(
  identity?: AzureIdentity | null
): () => Promise<{ token: string; expiresOnTimestamp: number }> {
  return async () => {
    const token = await (await credentialFor(identity)).getToken(AZURE_INGRESS_SCOPE);
    return { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  };
}

export interface AzureClientConfig {
  subscriptionId: string;
  resourceGroup: string;
  sandboxGroup: string;
  /** The group's region, e.g. `eastus2`; names the data-plane endpoint. */
  region: string;
  /** The data-plane endpoint itself, when it is not the region's default. */
  endpoint?: string | null;
  identity?: AzureIdentity | null;
  /** A ready-made data-plane token, in place of an identity (a live test). */
  staticToken?: string;
}

/**
 * The real client: the SDK and the identity library, loaded only here so
 * a Docker deployment never loads either.
 */
export async function createAzureSandboxClient(
  config: AzureClientConfig
): Promise<AzureSandboxClient> {
  const [{ SandboxGroupClient, endpointForRegion }, credential] = await Promise.all([
    import('@azure/containerapps-sandbox'),
    credentialFor(config.identity, config.staticToken),
  ]);
  const group = new SandboxGroupClient(
    credential,
    config.endpoint || endpointForRegion(config.region),
    config.subscriptionId,
    config.resourceGroup,
    config.sandboxGroup
  );
  const { sandboxes } = group;
  return {
    get: (id) => sandboxes.get(id),
    list: (options) => sandboxes.list(options),
    beginCreate: (body) => sandboxes.beginCreate(body),
    delete: (id) => sandboxes.delete(id),
    updatePorts: (id, ports) => group.ports.update(id, ports),
    removePort: (id, port) => group.ports.remove(id, port),
    beginStop: (id) => sandboxes.beginStop(id),
    beginResume: (id) => sandboxes.beginResume(id),
  };
}
