/**
 * From the organization's stored configuration to a provider that makes
 * sandboxes. The row is the `sandbox-orchestrator` connector config an
 * operator edits on Organization → Sandboxes (packages/sandbox-client
 * orchestrator-config.ts describes it and validates it); nothing about
 * where sandboxes are made is read from this process's environment.
 */

import {
  AZURE_CLIENT_SECRET_KEY,
  orchestratorSettingsOfRow,
  orchestratorTemplateEnv,
  parseOrchestratorInput,
  type SandboxOrchestratorSettings,
} from '@renkei/sandbox-client';
import {
  AzureSandboxProvider,
  DockerSandboxProvider,
  azureIngressToken,
  createAzureSandboxClient,
  type AzureIdentity,
  type AzureSandboxClient,
  type SandboxProvider,
} from '@renkei/sandbox-orchestrator';

/** Names this deployment among others sharing an engine or a sandbox group. */
const DEPLOYMENT = process.env.SANDBOX_DEPLOYMENT?.trim() || 'renkei';

export interface StoredRow {
  enabled: boolean;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface BuiltOrchestration {
  provider: SandboxProvider;
  /** What every sandbox's worker is started with. */
  env: Record<string, string>;
  idleSuspendMs: number;
  idleDeleteMs: number;
}

/** Stand-ins for what reaches outside this process, for tests. */
export interface BuildDeps {
  azureClient?: (settings: SandboxOrchestratorSettings['azure']) => Promise<AzureSandboxClient>;
}

function identityOf(
  settings: SandboxOrchestratorSettings,
  secrets: Record<string, string>
): AzureIdentity | null {
  const { tenantId, clientId } = settings.azure;
  const clientSecret = secrets[AZURE_CLIENT_SECRET_KEY];
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : null;
}

async function providerOf(
  settings: SandboxOrchestratorSettings,
  secrets: Record<string, string>,
  deps: BuildDeps
): Promise<SandboxProvider> {
  if (settings.provider === 'docker') {
    const docker = settings.docker;
    return new DockerSandboxProvider({
      image: docker.image,
      networks: docker.networks,
      publishHost: docker.publishHost,
      command: docker.command,
      memoryBytes: docker.memoryMb * 1_048_576,
      shmBytes: Math.min(1024, Math.max(64, Math.floor(docker.memoryMb / 4))) * 1_048_576,
      pidsLimit: 4096,
      cpus: docker.cpus,
      suspend: docker.suspend,
      nestedEngine: docker.nestedEngine,
      deployment: DEPLOYMENT,
      ...(docker.host ? { host: docker.host } : {}),
    });
  }
  const azure = settings.azure;
  const identity = identityOf(settings, secrets);
  const client = deps.azureClient
    ? await deps.azureClient(azure)
    : await createAzureSandboxClient({
        subscriptionId: azure.subscriptionId,
        resourceGroup: azure.resourceGroup,
        sandboxGroup: azure.sandboxGroup,
        region: azure.region,
        endpoint: azure.endpoint,
        identity,
      });
  return new AzureSandboxProvider({
    diskImage: azure.diskImage,
    cpu: azure.cpu,
    memory: azure.memory,
    disk: azure.disk,
    suspendMode: azure.suspendMode,
    vnetConnection: azure.vnetConnection,
    portAuth: azure.portAuth,
    entraAllowed: azure.entraAllowed,
    ingressToken: azureIngressToken(identity),
    allowedCidrs: azure.allowedCidrs,
    deployment: DEPLOYMENT,
    client,
  });
}

/**
 * The provider and rules a stored row asks for, or one sentence saying
 * why it cannot be used. A row is checked again here, as the page checked
 * it when it was saved: an older or hand-written row is refused in words.
 */
export async function buildFromStored(
  row: StoredRow | null,
  deps: BuildDeps = {}
): Promise<BuiltOrchestration | string> {
  if (!row) {
    return 'sandboxes are not set up yet: an operator configures them under Organization → Sandboxes';
  }
  if (!row.enabled) return 'sandboxes are switched off under Organization → Sandboxes';
  const settings = orchestratorSettingsOfRow(row.settings);
  const checked = parseOrchestratorInput({ ...settings, enabled: true });
  if (typeof checked === 'string')
    return `the stored sandbox configuration is not usable: ${checked}`;
  try {
    return {
      provider: await providerOf(settings, row.secrets, deps),
      env: orchestratorTemplateEnv(settings, row.secrets),
      idleSuspendMs: settings.idleSuspendMinutes * 60_000,
      idleDeleteMs: settings.idleEvictHours * 60 * 60_000,
    };
  } catch (error) {
    return `the sandbox provider could not be set up: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Try a configuration — the one stored, or one about to be saved — by
 * asking its provider whether it answers: the engine and the image for
 * Docker; the identity, its role and the sandbox group for Azure. A
 * failed try is an answer, in a sentence.
 */
export async function checkStored(
  row: StoredRow,
  deps: BuildDeps = {}
): Promise<{ ok: boolean; detail: string }> {
  const built = await buildFromStored({ ...row, enabled: true }, deps);
  if (typeof built === 'string') return { ok: false, detail: built };
  const settings = orchestratorSettingsOfRow(row.settings);
  const where =
    settings.provider === 'azure'
      ? `the sandbox group "${settings.azure.sandboxGroup}" in ${settings.azure.resourceGroup} (${settings.azure.region})`
      : `the Docker engine at ${settings.docker.host ?? 'the local socket'} with the image ${settings.docker.image}`;
  try {
    await built.provider.check();
  } catch (error) {
    return {
      ok: false,
      detail: `Could not reach ${where}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (settings.provider === 'azure' && settings.azure.portAuth === 'entra') {
    try {
      await built.provider.callerHeaders?.();
    } catch (error) {
      return {
        ok: false,
        detail: `Reached ${where}, but no Microsoft Entra token could be got for calling a sandbox: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, detail: `Reached ${where}. No sandbox was made.` };
}
