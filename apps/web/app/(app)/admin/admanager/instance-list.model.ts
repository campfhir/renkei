/**
 * The ADManager Plus instance registry (instance-list.tsx) and the draft
 * both instance forms edit (instance-config-fields.tsx), with no network
 * or React: an empty draft, what Create or Save sends, what the server-URL
 * preview says, what a reachability test sends and what its answer reads
 * as, when Create and Test can be pressed, and what the list shows after
 * each answer. The edit page's state is
 * [instanceId]/instance-config-form.model.ts. Tested in
 * instance-list.model.test.ts.
 */

import { parseBaseUrl } from '@renkei/connector-admanager/pure';

export interface InstanceDraft {
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  /** The PEM to store; empty keeps what is stored on edit and stores nothing on create. */
  caPem: string;
  /** Whether the edit form should clear a stored CA (an explicit choice). */
  clearCa: boolean;
  hasCustomCa: boolean;
  allowInsecureHttp: boolean;
  /** The ADManager Plus template the reset-password tool applies; empty means none. */
  resetPasswordTemplateName: string;
  enabled: boolean;
}

/** A new instance: labelled production (the safe default), verified https, on. */
export function emptyDraft(): InstanceDraft {
  return {
    name: '',
    environment: 'prod',
    baseUrl: '',
    tlsVerify: true,
    caPem: '',
    clearCa: false,
    hasCustomCa: false,
    allowInsecureHttp: false,
    resetPasswordTemplateName: '',
    enabled: true,
  };
}

/** What the admin routes accept. */
export function draftPayload(draft: InstanceDraft): Record<string, unknown> {
  return {
    name: draft.name,
    environment: draft.environment,
    baseUrl: draft.baseUrl,
    tlsVerify: draft.tlsVerify,
    // Absent keeps the stored CA; null clears it; text replaces it.
    ...(draft.clearCa ? { caPem: null } : draft.caPem.trim() ? { caPem: draft.caPem } : {}),
    allowInsecureHttp: draft.allowInsecureHttp,
    // Blank is sent as null so an edit can clear a stored template.
    resetPasswordTemplateName: draft.resetPasswordTemplateName.trim() || null,
    enabled: draft.enabled,
  };
}

/**
 * A change to the draft. Pasting a CA un-ticks "remove the stored CA", and
 * ticking it empties the pasted one: the two never both apply.
 */
export function editDraft(draft: InstanceDraft, patch: Partial<InstanceDraft>): InstanceDraft {
  const next = { ...draft, ...patch };
  if ('caPem' in patch) next.clearCa = false;
  if ('clearCa' in patch) next.caPem = '';
  return next;
}

/** The CA field's placeholder: says one is stored until a removal is chosen. */
export function caPlaceholder(draft: InstanceDraft): string {
  return draft.hasCustomCa && !draft.clearCa
    ? 'A CA certificate is stored — paste a new one to replace it'
    : '-----BEGIN CERTIFICATE-----';
}

/** The live normalization the server will apply to the URL. */
export function urlPreview(draft: InstanceDraft): { text: string; error: boolean } {
  if (!draft.baseUrl.trim())
    return { text: 'The REST API is reached at <server URL>/api/v1 and /api/v2.', error: false };
  const parsed = parseBaseUrl(draft.baseUrl, draft.allowInsecureHttp);
  if (!parsed) {
    return {
      text: draft.allowInsecureHttp
        ? 'Not a usable URL (no credentials, query or fragment).'
        : 'Must be an https URL — or allow insecure HTTP below for a plaintext lab server.',
      error: true,
    };
  }
  return { text: `REST API at ${parsed}/api/v1 and ${parsed}/api/v2`, error: false };
}

export interface ProbeResponse {
  ok: boolean;
  status?: number;
  error?: string;
}

/** What "Test reachability" sends for the unsaved draft: the transport settings, no name. */
export function probeBody(draft: InstanceDraft): Record<string, unknown> {
  return {
    baseUrl: draft.baseUrl,
    tlsVerify: draft.tlsVerify,
    caPem: draft.caPem || undefined,
    allowInsecureHttp: draft.allowInsecureHttp,
  };
}

/** What a reachability answer reads as. A 401 is the healthy answer: a REST API wants a token. */
export function probeText(probe: ProbeResponse): string {
  if (!probe.ok) return probe.error ?? 'The server could not be reached.';
  if (probe.status === 401)
    return 'Reachable — an ADManager Plus REST API is listening (it asked for a token, as expected).';
  return `Reachable — the server answered ${probe.status}.`;
}

/* ---------------------------------------------------------------- the list */

export interface InstanceRow {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  enabled: boolean;
}

export interface InstanceListState {
  instances: InstanceRow[];
  /** The new-instance form, when open. */
  draft: InstanceDraft | null;
  busy: boolean;
  error: string | null;
  /** What the last reachability test said about the draft. */
  probe: string | null;
}

export const initialInstanceList: InstanceListState = {
  instances: [],
  draft: null,
  busy: false,
  error: null,
  probe: null,
};

export type InstanceListAction =
  | { type: 'loaded'; instances: InstanceRow[] }
  | { type: 'load-failed'; error: string }
  | { type: 'new' }
  | { type: 'edit'; patch: Partial<InstanceDraft> }
  | { type: 'cancel' }
  | { type: 'testing' }
  | { type: 'tested'; probe: ProbeResponse }
  | { type: 'test-failed'; error: string }
  | { type: 'creating' }
  | { type: 'created' }
  | { type: 'create-failed'; error: string };

export function instanceListReducer(
  state: InstanceListState,
  action: InstanceListAction
): InstanceListState {
  switch (action.type) {
    case 'loaded':
      return { ...state, instances: action.instances };
    case 'load-failed':
      return { ...state, error: action.error };
    case 'new':
      return { ...state, draft: emptyDraft() };
    case 'edit':
      return state.draft ? { ...state, draft: editDraft(state.draft, action.patch) } : state;
    case 'cancel':
      return { ...state, draft: null, probe: null };
    case 'testing':
      return { ...state, busy: true, probe: null, error: null };
    case 'tested':
      return { ...state, busy: false, probe: probeText(action.probe) };
    case 'test-failed':
      return { ...state, busy: false, error: action.error };
    case 'creating':
      return { ...state, busy: true, error: null };
    case 'created':
      // The form closes; the list's next load shows the new row.
      return { ...state, busy: false, draft: null, probe: null };
    case 'create-failed':
      // The draft stays as typed, with the route's reason beside it.
      return { ...state, busy: false, error: action.error };
  }
}

/** "No instances registered yet." — only with nothing listed and no form open. */
export function showsEmpty(state: InstanceListState): boolean {
  return state.instances.length === 0 && !state.draft;
}

/** Create needs a name and a server URL, and nothing in flight. */
export function canCreate(state: InstanceListState): boolean {
  return Boolean(
    state.draft && !state.busy && state.draft.name.trim() && state.draft.baseUrl.trim()
  );
}

/** Test needs a server URL, and nothing in flight. */
export function canTest(state: InstanceListState): boolean {
  return Boolean(state.draft && !state.busy && state.draft.baseUrl.trim());
}
