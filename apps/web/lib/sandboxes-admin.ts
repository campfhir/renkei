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
  checkSandboxOrchestrator,
  mergeOrchestratorSecrets,
  orchestratorViewOfRow,
  sandboxOrchestratorStatus,
  type OrchestratorInput,
  type OrchestratorView,
  type SandboxOrchestratorStatus,
} from '@renkei/sandbox-client';

/** The setup as the page shows it, with what the orchestrator says of itself. */
export interface SandboxesView extends OrchestratorView {
  orchestrator: SandboxOrchestratorStatus;
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
  return { ...orchestratorViewOfRow(row.val), orchestrator: await sandboxOrchestratorStatus() };
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
 * Tries the setup the operator is ABOUT to save — the form's fields, the
 * stored secrets where none were typed — by handing it to the
 * orchestrator, which asks the provider whether it answers. Nothing is
 * stored and no sandbox is made.
 */
export async function testSandboxes(
  input: OrchestratorInput
): Promise<{ ok: boolean; detail: string }> {
  const row = await merged(input);
  if (typeof row === 'string') return { ok: false, detail: row };
  return checkSandboxOrchestrator(row);
}
