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
  diskImagePlanFor,
  ensureDiskImage,
  trySandbox,
  type AzureIdentity,
  type DiskImagePlan,
  type DiskImagePreparer,
  type TrialProbe,
  type TrialSandboxes,
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
  /** Where a sandbox reaches the orchestrator. */
  callbackUrl: string;
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

async function azureClientOf(
  settings: SandboxOrchestratorSettings,
  secrets: Record<string, string>,
  deps: BuildDeps
): Promise<AzureSandboxClient> {
  const azure = settings.azure;
  return deps.azureClient
    ? await deps.azureClient(azure)
    : await createAzureSandboxClient({
        subscriptionId: azure.subscriptionId,
        resourceGroup: azure.resourceGroup,
        sandboxGroup: azure.sandboxGroup,
        region: azure.region,
        endpoint: azure.endpoint,
        identity: identityOf(settings, secrets),
      });
}

async function providerOf(
  settings: SandboxOrchestratorSettings,
  secrets: Record<string, string>,
  deps: BuildDeps,
  diskImage: string
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
  const client = await azureClientOf(settings, secrets, deps);
  return new AzureSandboxProvider({
    diskImage,
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
  deps: BuildDeps = {},
  /** The disk image prepared for this build, where the setup leaves it to the orchestrator. */
  preparedDiskImage: string | null = null
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
      provider: await providerOf(
        settings,
        row.secrets,
        deps,
        preparedDiskImage ?? settings.azure.diskImage
      ),
      env: orchestratorTemplateEnv(settings, row.secrets),
      idleSuspendMs: settings.idleSuspendMinutes * 60_000,
      idleDeleteMs: settings.idleEvictHours * 60 * 60_000,
      callbackUrl: settings.callbackUrl,
    };
  } catch (error) {
    return `the sandbox provider could not be set up: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** What preparing a disk image for this build needs. */
export interface ImageDeps {
  preparer: DiskImagePreparer;
  /** This orchestrator's full commit (GIT_SHA); null when the build does not know it. */
  commit: string | null;
  /** How long Test connection waits on a preparation before saying it is still under way. */
  testWaitMs?: number;
  /** How often a building image is looked at again. */
  pollMs?: number;
}

/** The disk image an Azure setup leaves to the orchestrator: which one, and its key among preparations. */
export interface AutomaticImage {
  key: string;
  plan: DiskImagePlan;
}

/**
 * Whether this setup leaves the disk image to the orchestrator — Azure,
 * with no disk image pinned — and if so the one to prepare for this
 * build; null when it does not; a sentence when it does but cannot be
 * done (a build that does not know its commit).
 */
export function automaticImageOf(
  row: StoredRow,
  commit: string | null
): AutomaticImage | string | null {
  const settings = orchestratorSettingsOfRow(row.settings);
  if (settings.provider !== 'azure' || settings.azure.diskImage) return null;
  if (!commit) {
    return 'this orchestrator was built without its commit (GIT_SHA), so it cannot have a disk image built to match it: enter a disk image id on Organization → Sandboxes to pin one';
  }
  const plan = diskImagePlanFor(settings.azure.imageRepository, commit);
  const azure = settings.azure;
  return {
    key: `${azure.subscriptionId}/${azure.resourceGroup}/${azure.sandboxGroup}|${plan.base}`,
    plan,
  };
}

/**
 * Prepare (or join the preparation of) this setup's disk image: the one
 * way it happens, whether the orchestrator is starting, the setup was
 * saved, or an operator asked for it again.
 */
export function startDiskImage(
  row: StoredRow,
  image: AutomaticImage,
  preparer: DiskImagePreparer,
  deps: BuildDeps = {},
  options: { again?: boolean; pollMs?: number } = {}
): Promise<string> {
  const settings = orchestratorSettingsOfRow(row.settings);
  return preparer.prepare(
    image.key,
    image.plan,
    async (onProgress) => {
      const client = await azureClientOf(settings, row.secrets, deps);
      if (!client.diskImages)
        throw new Error('this sandbox group cannot be asked to build disk images');
      return ensureDiskImage({
        client: client.diskImages,
        plan: image.plan,
        ...(onProgress ? { onProgress } : {}),
        ...(options.pollMs ? { pollMs: options.pollMs } : {}),
      });
    },
    options
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What making a test sandbox needs, besides the setup being tried. */
export interface TrialDeps {
  trials: TrialSandboxes;
  masterKey: string;
  newId: () => string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: TrialProbe;
}

/**
 * Try a configuration — the one stored, or one about to be saved — by
 * asking its provider whether it answers (the engine and the image for
 * Docker; the identity, its role and the sandbox group for Azure) and
 * then, given `trial`, by making a test sandbox from it the way every
 * sandbox is made and waiting for its worker to answer
 * (@renkei/sandbox-orchestrator trial.ts). A failed try is an answer, in
 * a sentence.
 */
export async function checkStored(
  row: StoredRow,
  deps: BuildDeps = {},
  trial?: TrialDeps,
  image?: ImageDeps,
  /**
   * Run as a job (check-jobs.ts): each step said as it is reached, and a
   * signal that cancels it. Given one, the test waits on a disk image
   * until it is ready rather than for `testWaitMs` — it can be cancelled.
   */
  progress?: { signal?: AbortSignal; step?: (text: string) => void }
): Promise<{ ok: boolean; detail: string }> {
  const step = (text: string): void => progress?.step?.(text);
  let built = await buildFromStored({ ...row, enabled: true }, deps);
  if (typeof built === 'string') return { ok: false, detail: built };
  const settings = orchestratorSettingsOfRow(row.settings);
  const where =
    settings.provider === 'azure'
      ? `the sandbox group "${settings.azure.sandboxGroup}" in ${settings.azure.resourceGroup} (${settings.azure.region})`
      : `the Docker engine at ${settings.docker.host ?? 'the local socket'} with the image ${settings.docker.image}`;
  step(`Reaching ${where}.`);
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
  if (!trial) return { ok: true, detail: `Reached ${where}. No sandbox was made.` };

  // Where the setup leaves the disk image to the orchestrator, the test
  // sandbox boots from the one prepared for this build: started (or
  // joined) here exactly as the orchestrator itself would.
  let source =
    settings.provider === 'azure'
      ? `the disk image "${settings.azure.diskImage}" in ${settings.azure.sandboxGroup}`
      : `the image ${settings.docker.image}`;
  const automatic = automaticImageOf(row, image?.commit ?? null);
  if (typeof automatic === 'string')
    return { ok: false, detail: `Reached ${where}, but ${automatic}.` };
  if (automatic) {
    if (!image)
      return { ok: false, detail: `Reached ${where}, but no disk image can be prepared here.` };
    const preparing = startDiskImage(row, automatic, image.preparer, deps, {
      ...(image.pollMs ? { pollMs: image.pollMs } : {}),
    });
    if (image.preparer.status(automatic.key)?.state !== 'ready') {
      step(
        `Waiting for the disk image for build ${automatic.plan.build}, being built from ${automatic.plan.base}; this takes a few minutes the first time.`
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const waited = await Promise.race([
      preparing.then(
        (id) => ({ id }),
        (error: unknown) => ({ error: messageOf(error) })
      ),
      new Promise<null | 'cancelled'>((resolve) => {
        if (progress?.signal) {
          // As a job it waits until the image is ready, or until it is cancelled.
          onAbort = () => resolve('cancelled');
          if (progress.signal.aborted) onAbort();
          else progress.signal.addEventListener('abort', onAbort, { once: true });
        } else {
          timer = setTimeout(() => resolve(null), image.testWaitMs ?? 60_000);
        }
      }),
    ]).finally(() => {
      clearTimeout(timer);
      if (onAbort) progress?.signal?.removeEventListener('abort', onAbort);
    });
    if (waited === 'cancelled') {
      return {
        ok: false,
        detail: `The test was cancelled while the disk image for build ${automatic.plan.build} was being built; the build carries on, and sandboxes use it once it is ready.`,
      };
    }
    if (waited === null) {
      const status = image.preparer.status(automatic.key);
      return {
        ok: false,
        detail: `Reached ${where}. The disk image for build ${automatic.plan.build} is being built from ${automatic.plan.base}${
          status?.detail ? ` (the group says: ${status.detail})` : ''
        }; this takes a few minutes the first time. Press Test connection again once it is ready.`,
      };
    }
    if ('error' in waited) return { ok: false, detail: `Reached ${where}, but ${waited.error}.` };
    step(`The disk image for build ${automatic.plan.build} is ready (${waited.id}).`);
    built = await buildFromStored({ ...row, enabled: true }, deps, waited.id);
    if (typeof built === 'string') return { ok: false, detail: built };
    source = `the disk image built for build ${automatic.plan.build} ("${waited.id}") in ${settings.azure.sandboxGroup}`;
  }

  const tried = await trySandbox({
    provider: built.provider,
    trials: trial.trials,
    masterKey: trial.masterKey,
    callbackUrl: built.callbackUrl,
    env: built.env,
    source,
    newId: trial.newId,
    ...(trial.timeoutMs !== undefined ? { timeoutMs: trial.timeoutMs } : {}),
    ...(trial.now ? { now: trial.now } : {}),
    ...(trial.sleep ? { sleep: trial.sleep } : {}),
    ...(trial.probe ? { probe: trial.probe } : {}),
    ...(progress?.signal ? { signal: progress.signal } : {}),
    ...(progress?.step ? { onStep: progress.step } : {}),
  });
  return tried.ok ? { ok: true, detail: `Reached ${where}. ${tried.detail}` } : tried;
}
