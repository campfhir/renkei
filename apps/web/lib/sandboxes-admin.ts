/**
 * The Organization → Sandboxes page's server side: reading and writing
 * the organization's sandbox setup (the `sandbox-orchestrator` connector
 * config, its secrets sealed with the deployment key) and having the
 * orchestrator try a setup before it is saved. Shared by the two admin
 * routes so they cannot drift on what a valid row is; what a valid row
 * IS lives in @renkei/sandbox-client's orchestrator-config.ts, which the
 * orchestrator reads the row back with.
 */

import { loadKeyring } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import {
  SANDBOX_ORCHESTRATOR_CONNECTOR,
  cancelSandboxCheck,
  mergeOrchestratorSecrets,
  notStartedCheck,
  orchestratorViewOfRow,
  prepareSandboxImage,
  sandboxCheckStatus,
  sandboxOrchestratorStatus,
  startSandboxCheck,
  type OrchestratorInput,
  type OrchestratorView,
  type SandboxCheckJob,
  type SandboxOrchestratorStatus,
} from '@renkei/sandbox-client';

/** The setup as the page shows it, with what the orchestrator says of itself. */
export interface SandboxesView extends OrchestratorView {
  orchestrator: SandboxOrchestratorStatus;
  /** Test connection's job: the one running, or the last one — so a page opened again shows it. */
  check: SandboxCheckJob | null;
}

function encryptionKey(): Buffer | null {
  const key = loadKeyring('TOKEN_ENCRYPTION_KEY');
  return key.ok ? key.val : null;
}

export async function readSandboxes(): Promise<SandboxesView | 'ERROR'> {
  const key = encryptionKey();
  if (!key) return 'ERROR';
  const row = await getConnectorConfig(SANDBOX_ORCHESTRATOR_CONNECTOR, key);
  if (!row.ok) return 'ERROR';
  const [orchestrator, check] = await Promise.all([
    sandboxOrchestratorStatus(),
    sandboxCheckStatus(),
  ]);
  return { ...orchestratorViewOfRow(row.val), orchestrator, check };
}

/** The row as it would be saved from this input: typed secrets over the stored ones. */
async function merged(
  input: OrchestratorInput
): Promise<{ settings: Record<string, unknown>; secrets: Record<string, string> } | string> {
  const key = encryptionKey();
  if (!key) return 'Server misconfigured';
  const existing = await getConnectorConfig(SANDBOX_ORCHESTRATOR_CONNECTOR, key);
  if (!existing.ok) return 'Could not read the stored configuration';
  const secrets = mergeOrchestratorSecrets(input, existing.val?.secrets ?? {});
  if (typeof secrets === 'string') return secrets;
  return { settings: { ...input.settings }, secrets };
}

/** A message that is the operator's to fix (a 400), as against one that is ours (a 500). */
export function isInputProblem(message: string): boolean {
  return message.startsWith('Enter ');
}

export async function saveSandboxes(input: OrchestratorInput): Promise<SandboxesView | string> {
  const key = encryptionKey();
  if (!key) return 'Server misconfigured';
  const row = await merged(input);
  if (typeof row === 'string') return row;
  const written = await setConnectorConfig(
    SANDBOX_ORCHESTRATOR_CONNECTOR,
    { enabled: input.enabled, settings: row.settings, secrets: row.secrets },
    key
  );
  if (!written.ok) return 'Could not store the configuration';
  invalidateConnectorConfigCache(SANDBOX_ORCHESTRATOR_CONNECTOR);
  const view = await readSandboxes();
  return view === 'ERROR' ? 'Saved, but the configuration could not be read back' : view;
}

/**
 * Starts trying the setup the operator is ABOUT to save — the form's
 * fields, the stored secrets where none were typed — on the orchestrator,
 * which asks the provider whether it answers and makes a test sandbox. It
 * runs there as a job; this answers it at once (one already running, if
 * there is one). Nothing is stored. A setup that could not be saved is
 * answered as a test that ended before it began.
 */
export async function testSandboxes(input: OrchestratorInput): Promise<SandboxCheckJob> {
  const row = await merged(input);
  if (typeof row === 'string') return notStartedCheck(row);
  return startSandboxCheck(row);
}

/** The test running, or the last one; null when there has been none. */
export function sandboxesTestStatus(): Promise<SandboxCheckJob | null> {
  return sandboxCheckStatus();
}

/** Cancel the running test (its sandbox is removed before it ends). */
export function cancelSandboxesTest(id: string | null): Promise<SandboxCheckJob | null> {
  return cancelSandboxCheck(id);
}

/**
 * Has the orchestrator prepare the stored setup's disk image again (after
 * a failed build), then reads the setup back with what it says now.
 */
export async function prepareSandboxesImage(): Promise<SandboxesView | 'ERROR'> {
  await prepareSandboxImage();
  return readSandboxes();
}
