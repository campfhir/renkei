/**
 * The Organization → Sandboxes form's state (sandboxes-form.tsx): where
 * the organization's sandboxes are made, how they are sized, when they
 * are suspended and evicted, and what each is started with.
 *
 * The component makes the calls and dispatches what the person did and
 * what the server answered; everything the screen decides from that is
 * here, and tested in sandboxes-form.model.test.ts:
 *   - the draft a stored setup opens as, and the empty one;
 *   - which provider's fields show, and when the service principal and
 *     the Entra allow-list are asked for;
 *   - secrets are write-only: a stored one shows as stored, a blank
 *     field keeps it, and a save clears what was typed;
 *   - the variables a sandbox is started with: added, renamed, removed,
 *     a value typed;
 *   - what Save and Test send;
 *   - what a save, a test and a failure leave on screen, and the badge
 *     and the line that say what the orchestrator is doing.
 *
 * What makes a setup VALID is not decided here: the server checks it
 * (@renkei/sandbox-client orchestrator-config.ts) and its sentence is
 * shown as it came.
 */

import type { SandboxesView } from '@/lib/sandboxes-admin';

export interface EnvRow {
  name: string;
  /** What was typed this visit; blank keeps a stored value. */
  value: string;
}

export interface SandboxesDraft {
  enabled: boolean;
  provider: 'azure' | 'docker';
  idleSuspendMinutes: string;
  idleEvictHours: string;
  azure: {
    subscriptionId: string;
    resourceGroup: string;
    sandboxGroup: string;
    region: string;
    endpoint: string;
    diskImage: string;
    cpu: string;
    memory: string;
    disk: string;
    suspendMode: 'Memory' | 'Disk';
    vnetConnection: string;
    portAuth: 'entra' | 'anonymous';
    /** One identity per line. */
    entraAllowed: string;
    /** One range per line. */
    allowedCidrs: string;
    tenantId: string;
    clientId: string;
  };
  /** Typed this visit; blank keeps the stored one. */
  azureClientSecret: string;
  docker: {
    image: string;
    host: string;
    /** Comma-separated. */
    networks: string;
    publishHost: string;
    suspend: 'stop' | 'pause';
    nestedEngine: boolean;
    memoryMb: string;
    cpus: string;
  };
  env: EnvRow[];
}

export interface SandboxesState {
  /** The setup as last read or saved; null when it could not be read. */
  view: SandboxesView | null;
  draft: SandboxesDraft;
  busy: 'save' | 'test' | null;
  notice: string | null;
  error: string | null;
}

export type SandboxesAction =
  | { type: 'set'; patch: Partial<Omit<SandboxesDraft, 'azure' | 'docker' | 'env'>> }
  | { type: 'setAzure'; patch: Partial<SandboxesDraft['azure']> }
  | { type: 'setDocker'; patch: Partial<SandboxesDraft['docker']> }
  | { type: 'envAdded' }
  | { type: 'envNamed'; index: number; name: string }
  | { type: 'envValued'; index: number; value: string }
  | { type: 'envRemoved'; index: number }
  | { type: 'sent'; what: 'save' | 'test' }
  | { type: 'saved'; view: SandboxesView }
  | { type: 'tested'; ok: boolean; detail: string }
  | { type: 'failed'; message: string };

/** What a sandbox worker needs to be started with, offered as the first rows of an empty setup. */
export const SUGGESTED_ENV = [
  'DATABASE_URL',
  'DELEGATE_WORKER_URL',
  'DELEGATE_WORKER_API_KEY',
  'SANDBOX_ENV_SECRETS_KEY',
  'LOG_ENCRYPTION_KEY',
];

export function draftOf(view: SandboxesView | null): SandboxesDraft {
  const settings = view?.settings;
  const azure = settings?.azure;
  const docker = settings?.docker;
  return {
    enabled: view?.configured ? view.enabled : true,
    provider: settings?.provider ?? 'azure',
    idleSuspendMinutes: String(settings?.idleSuspendMinutes ?? 15),
    idleEvictHours: String(settings?.idleEvictHours ?? 24),
    azure: {
      subscriptionId: azure?.subscriptionId ?? '',
      resourceGroup: azure?.resourceGroup ?? '',
      sandboxGroup: azure?.sandboxGroup ?? '',
      region: azure?.region ?? '',
      endpoint: azure?.endpoint ?? '',
      diskImage: azure?.diskImage ?? '',
      cpu: azure?.cpu ?? '2000m',
      memory: azure?.memory ?? '4096Mi',
      disk: azure?.disk ?? '40Gi',
      suspendMode: azure?.suspendMode ?? 'Memory',
      vnetConnection: azure?.vnetConnection ?? '',
      portAuth: azure?.portAuth ?? 'entra',
      entraAllowed: (azure?.entraAllowed ?? []).join('\n'),
      allowedCidrs: (azure?.allowedCidrs ?? []).join('\n'),
      tenantId: azure?.tenantId ?? '',
      clientId: azure?.clientId ?? '',
    },
    azureClientSecret: '',
    docker: {
      image: docker?.image ?? 'renkei-sandbox:latest',
      host: docker?.host ?? '',
      networks: (docker?.networks ?? ['renkei-sandbox']).join(', '),
      publishHost: docker?.publishHost ?? '',
      suspend: docker?.suspend ?? 'stop',
      nestedEngine: docker?.nestedEngine ?? false,
      memoryMb: String(docker?.memoryMb ?? 4096),
      cpus: String(docker?.cpus ?? 0),
    },
    // A setup never saved starts with the variables a worker needs, to be filled in.
    env: (view?.configured ? (settings?.envNames ?? []) : SUGGESTED_ENV).map((name) => ({
      name,
      value: '',
    })),
  };
}

export function init(view: SandboxesView | null): SandboxesState {
  return { view, draft: draftOf(view), busy: null, notice: null, error: null };
}

export function reducer(state: SandboxesState, action: SandboxesAction): SandboxesState {
  const edited = (draft: SandboxesDraft): SandboxesState => ({
    ...state,
    draft,
    notice: null,
    error: null,
  });
  switch (action.type) {
    case 'set':
      return edited({ ...state.draft, ...action.patch });
    case 'setAzure':
      return edited({ ...state.draft, azure: { ...state.draft.azure, ...action.patch } });
    case 'setDocker':
      return edited({ ...state.draft, docker: { ...state.draft.docker, ...action.patch } });
    case 'envAdded':
      return edited({ ...state.draft, env: [...state.draft.env, { name: '', value: '' }] });
    case 'envNamed':
      return edited({
        ...state.draft,
        env: state.draft.env.map((row, index) =>
          // A variable's name is capitals, digits and underscores: typed as such.
          index === action.index
            ? { ...row, name: action.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }
            : row
        ),
      });
    case 'envValued':
      return edited({
        ...state.draft,
        env: state.draft.env.map((row, index) =>
          index === action.index ? { ...row, value: action.value } : row
        ),
      });
    case 'envRemoved':
      return edited({
        ...state.draft,
        env: state.draft.env.filter((_row, index) => index !== action.index),
      });
    case 'sent':
      return { ...state, busy: action.what, notice: null, error: null };
    case 'saved':
      // The server's answer is the setup now; what was typed as a secret is gone from the page.
      return {
        view: action.view,
        draft: draftOf(action.view),
        busy: null,
        notice: 'Saved.',
        error: null,
      };
    case 'tested':
      return {
        ...state,
        busy: null,
        notice: action.ok ? action.detail : null,
        error: action.ok ? null : action.detail,
      };
    case 'failed':
      return { ...state, busy: null, notice: null, error: action.message };
  }
}

/** Save and Test are one at a time. */
export function canSubmit(state: SandboxesState): boolean {
  return state.busy === null;
}

export function saveLabel(state: SandboxesState): string {
  return state.busy === 'save' ? 'Saving…' : 'Save';
}

export function testLabel(state: SandboxesState): string {
  return state.busy === 'test' ? 'Testing…' : 'Test connection';
}

/** A service principal is being named: its client secret is then asked for. */
export function usesServicePrincipal(state: SandboxesState): boolean {
  return Boolean(state.draft.azure.tenantId.trim() || state.draft.azure.clientId.trim());
}

/** With Entra on the worker port, the identities allowed to call a worker are asked for. */
export function asksEntraAllowed(state: SandboxesState): boolean {
  return state.draft.azure.portAuth === 'entra';
}

/** Whether a variable's value is already stored: its field may then be left blank. */
export function envIsStored(state: SandboxesState, name: string): boolean {
  return Boolean(name) && (state.view?.envStored ?? []).includes(name);
}

export function envPlaceholder(state: SandboxesState, name: string): string {
  return envIsStored(state, name) ? '•••••••• (stored; leave blank to keep)' : 'value';
}

export function clientSecretPlaceholder(state: SandboxesState): string {
  return state.view?.hasAzureClientSecret
    ? '•••••••• (stored; leave blank to keep)'
    : 'client secret';
}

function lines(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** What Save and Test send: the whole setup, secrets only where one was typed. */
export function requestBody(state: SandboxesState): Record<string, unknown> {
  const { draft } = state;
  const named = draft.env.filter((row) => row.name.trim());
  const envValues: Record<string, string> = {};
  for (const row of named) {
    if (row.value !== '') envValues[row.name.trim()] = row.value;
  }
  return {
    enabled: draft.enabled,
    provider: draft.provider,
    idleSuspendMinutes: draft.idleSuspendMinutes.trim(),
    idleEvictHours: draft.idleEvictHours.trim(),
    azure: {
      ...draft.azure,
      entraAllowed: lines(draft.azure.entraAllowed),
      allowedCidrs: lines(draft.azure.allowedCidrs),
    },
    docker: {
      ...draft.docker,
      networks: lines(draft.docker.networks),
      memoryMb: draft.docker.memoryMb.trim(),
      cpus: draft.docker.cpus.trim(),
    },
    envNames: named.map((row) => row.name.trim()),
    envValues,
    azureClientSecret: draft.azureClientSecret || null,
  };
}

export type SetupBadge = 'Not configured' | 'Enabled' | 'Disabled';

export function badge(state: SandboxesState): SetupBadge {
  if (!state.view?.configured) return 'Not configured';
  return state.view.enabled ? 'Enabled' : 'Disabled';
}

/**
 * What the orchestrator is doing with the setup, in a sentence: the line
 * under the heading. `tone` says how it should look.
 */
export function orchestratorLine(state: SandboxesState): {
  tone: 'ok' | 'warn' | 'off';
  text: string;
} {
  const orchestrator = state.view?.orchestrator;
  if (!orchestrator || !orchestrator.wired) {
    return {
      tone: 'off',
      text: 'This deployment runs no sandbox orchestrator, so nothing here is in use: sandboxes are served by the shared sandbox worker. Set SANDBOX_ORCHESTRATOR_URL on the app to use one.',
    };
  }
  if (!orchestrator.reachable) {
    return { tone: 'warn', text: 'The sandbox orchestrator is not answering.' };
  }
  if (orchestrator.problem) {
    return { tone: 'warn', text: `No sandbox can be made: ${orchestrator.problem}.` };
  }
  return {
    tone: 'ok',
    text: `The orchestrator is making sandboxes on ${orchestrator.provider === 'azure' ? 'Azure' : orchestrator.provider === 'docker' ? 'Docker' : (orchestrator.provider ?? 'its provider')}. A saved change takes effect within a quarter of a minute.`,
  };
}
