/**
 * The model roster's state (model-forms.tsx): the rows as last loaded, the
 * one draft form that serves both create and edit, and the two provider
 * checks the form can run before saving ("List available models" and
 * "Test connection").
 *
 * The component makes the calls and dispatches what the person did and
 * what the server answered; everything the screen decides from that is
 * here, and tested in model-forms.model.test.ts:
 *   - which fields the provider and API surface show (the API surface is
 *     OpenAI-dialect only; an image surface disables "Organization
 *     default" and "Test connection"), and the reasoning-effort hint and
 *     suggestions per provider;
 *   - what goes stale when: the credentials clear the model list and the
 *     test result, the model id and reasoning effort clear the test only;
 *   - typed token counts (200k, 1m, 4k, 8000) and what Save refuses;
 *   - what Save, List and Test send, isDefault included (never for an
 *     image model);
 *   - the roster rows' badges, the data-handling warning among them;
 *   - the empty draft (the first model is the organization default).
 *
 * The API key is write-only: the list shows presence, the edit form ships
 * blank and a blank submit keeps the stored key.
 */

import { parseTokenCount } from '@/lib/format-tokens';

export interface ModelRow {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  settings: {
    maxOutputTokens?: number;
    contextWindow?: number;
    temperature?: number;
    apiVersion?: string;
    reasoningEffort?: string;
    apiSurface?: string;
    dataResidency?: string;
    providerRetention?: string;
    baaCovered?: boolean;
    notes?: string;
  } | null;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
}

export interface ModelDraft {
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: string;
  contextWindow: string;
  temperature: string;
  apiVersion: string;
  reasoningEffort: string;
  /**
   * '' = chat-completions (the default); 'responses' = the Responses API;
   * 'images' = the OpenAI Images API and 'flux' = Black Forest Labs FLUX on
   * Azure AI Foundry — image generation models, not chat ones.
   */
  apiSurface: string;
  /**
   * Data handling — the operator's statement, stored on the row's settings
   * and read by the roster badge and the PHI-connector gate (org setting
   * "Require a BAA-covered model for PHI connectors").
   */
  dataResidency: string;
  /** '' = unknown (the stored default); else one of PROVIDER_RETENTIONS. */
  providerRetention: string;
  baaCovered: boolean;
  notes: string;
  apiKey: string;
  /** '' = type/keep a key; a config id = reuse that config's stored key. */
  apiKeyFromId: string;
  enabled: boolean;
  isDefault: boolean;
}

/** One row of the provider's answer to "what models do you offer?". */
export interface AvailableModelRow {
  id: string;
  displayName: string | null;
}

export interface ModelFormsState {
  /** null until the first load answers: the empty state must not flash before then. */
  models: ModelRow[] | null;
  loadError: string | null;
  /** The row the form edits, 'new' for a model being added, null with the form closed. */
  editingId: string | 'new' | null;
  draft: ModelDraft;
  saving: boolean;
  formError: string | null;
  /*
    The provider's live model list, fetched on demand with whichever key
    the form can reach — a freshly typed one, a sibling config's, or the
    stored key of the row being edited. Cleared whenever the credentials it
    was fetched with change: a list from the old key is not a smaller
    inconvenience than no list, it is wrong with confidence.
  */
  available: AvailableModelRow[] | null;
  listing: boolean;
  listError: string | null;
  /*
    The "Test connection" result: a real chat completion, so it goes stale
    on anything that changes what would be sent — the same credential
    fields that invalidate the model list, plus the model id and reasoning
    effort (which the list doesn't depend on).
  */
  testing: boolean;
  testError: string | null;
  testReply: string | null;
}

/** One field of the draft changed to a value of its own type. */
export type DraftEdit = {
  [K in keyof ModelDraft]: { type: 'edited'; field: K; value: ModelDraft[K] };
}[keyof ModelDraft];

export type ModelFormsAction =
  | { type: 'loaded'; models: ModelRow[] }
  | { type: 'loadFailed'; error: string | null | undefined }
  | { type: 'startCreate' }
  | { type: 'startEdit'; row: ModelRow }
  | { type: 'closeForm' }
  | DraftEdit
  /** A model id picked from the provider's live list. */
  | { type: 'picked'; model: string }
  | { type: 'listSent' }
  | { type: 'listed'; models: AvailableModelRow[] }
  | { type: 'listFailed'; error: string | null | undefined }
  | { type: 'testSent' }
  | { type: 'tested'; reply: string }
  | { type: 'testFailed'; error: string | null | undefined }
  | { type: 'saveSent' }
  | { type: 'saved' }
  /** Save refused, by the form's own check or by the server; the draft stays as typed. */
  | { type: 'saveFailed'; error: string }
  | { type: 'removeFailed'; error: string };

export const emptyDraft: ModelDraft = {
  label: '',
  provider: 'anthropic',
  model: '',
  baseUrl: '',
  maxOutputTokens: '',
  contextWindow: '',
  temperature: '',
  apiVersion: '',
  reasoningEffort: '',
  apiSurface: '',
  dataResidency: '',
  providerRetention: '',
  baaCovered: false,
  notes: '',
  apiKey: '',
  apiKeyFromId: '',
  enabled: true,
  isDefault: false,
};

export const initialModelForms: ModelFormsState = {
  models: null,
  loadError: null,
  editingId: null,
  draft: emptyDraft,
  saving: false,
  formError: null,
  available: null,
  listing: false,
  listError: null,
  testing: false,
  testError: null,
  testReply: null,
};

/** Common model ids per provider, offered as suggestions — any id is accepted. */
export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  anthropic: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
};

/** The draft a stored row opens as: settings as text, the key blank (blank keeps it). */
export function draftOf(row: ModelRow): ModelDraft {
  const settings = row.settings;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const count = (value: unknown) => (typeof value === 'number' ? String(value) : '');
  return {
    label: row.label,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl ?? '',
    maxOutputTokens: count(settings?.maxOutputTokens),
    contextWindow: count(settings?.contextWindow),
    temperature: count(settings?.temperature),
    apiVersion: text(settings?.apiVersion),
    reasoningEffort: text(settings?.reasoningEffort),
    apiSurface: text(settings?.apiSurface),
    dataResidency: text(settings?.dataResidency),
    providerRetention: text(settings?.providerRetention),
    baaCovered: settings?.baaCovered === true,
    notes: text(settings?.notes),
    apiKey: '',
    apiKeyFromId: '',
    enabled: row.enabled,
    isDefault: row.isDefault,
  };
}

/** The Images API and FLUX draw pictures; every other surface chats. */
export function isImageSurface(apiSurface: string | undefined): boolean {
  return apiSurface === 'images' || apiSurface === 'flux';
}

/** The fields whose change makes a fetched model list (and so a test) answer for the wrong connection. */
const CREDENTIAL_FIELDS: readonly (keyof ModelDraft)[] = [
  'provider',
  'baseUrl',
  'apiSurface',
  'apiKey',
  'apiKeyFromId',
  'apiVersion',
];

/** The fields whose change makes only the test result stale: they change what a completion sends. */
const TEST_FIELDS: readonly (keyof ModelDraft)[] = ['model', 'reasoningEffort'];

const noChecks = {
  available: null,
  listError: null,
  testError: null,
  testReply: null,
} satisfies Partial<ModelFormsState>;

const noTest = { testError: null, testReply: null } satisfies Partial<ModelFormsState>;

/** The draft after one edit, with the rules one field imposes on the others. */
function editDraft(draft: ModelDraft, edit: DraftEdit): ModelDraft {
  const next = { ...draft, [edit.field]: edit.value };
  switch (edit.field) {
    case 'provider':
      // The API surface is an OpenAI-dialect setting; switching away drops it.
      return { ...next, apiSurface: edit.value === 'openai' ? draft.apiSurface : '' };
    case 'apiSurface':
      // An image model cannot answer chat, so it can never be the default.
      return { ...next, isDefault: isImageSurface(edit.value) ? false : draft.isDefault };
    case 'apiKeyFromId':
      // A borrowed key replaces whatever was typed.
      return { ...next, apiKey: '' };
    case 'isDefault':
      return { ...next, isDefault: edit.value && !isImageSurface(draft.apiSurface) };
    default:
      return next;
  }
}

function fallback(error: string | null | undefined, otherwise: string): string {
  return error || otherwise;
}

export function modelFormsReducer(
  state: ModelFormsState,
  action: ModelFormsAction
): ModelFormsState {
  switch (action.type) {
    case 'loaded':
      return { ...state, models: action.models, loadError: null };
    case 'loadFailed':
      return { ...state, loadError: fallback(action.error, 'Could not load models') };
    case 'startCreate':
      return {
        ...state,
        ...noChecks,
        // The first model is the organization default: agents cannot run without one.
        draft: { ...emptyDraft, isDefault: (state.models ?? []).length === 0 },
        editingId: 'new',
        formError: null,
      };
    case 'startEdit':
      return {
        ...state,
        ...noChecks,
        draft: draftOf(action.row),
        editingId: action.row.id,
        formError: null,
      };
    case 'closeForm':
      return { ...state, editingId: null, draft: emptyDraft, formError: null };
    case 'edited': {
      const draft = editDraft(state.draft, action);
      if (CREDENTIAL_FIELDS.includes(action.field)) return { ...state, ...noChecks, draft };
      if (TEST_FIELDS.includes(action.field)) return { ...state, ...noTest, draft };
      return { ...state, draft };
    }
    case 'picked':
      if (action.model === state.draft.model) return state;
      return { ...state, ...noTest, draft: { ...state.draft, model: action.model } };
    case 'listSent':
      return { ...state, listing: true, listError: null };
    case 'listed':
      return { ...state, listing: false, available: action.models };
    case 'listFailed':
      return {
        ...state,
        listing: false,
        available: null,
        listError: fallback(action.error, 'Could not list models'),
      };
    case 'testSent':
      return { ...state, ...noTest, testing: true };
    case 'tested':
      return { ...state, testing: false, testReply: action.reply || '(no text in the reply)' };
    case 'testFailed':
      return {
        ...state,
        testing: false,
        testReply: null,
        testError: fallback(action.error, 'Could not reach the provider'),
      };
    case 'saveSent':
      return { ...state, saving: true, formError: null };
    case 'saved':
      return { ...state, saving: false, editingId: null, draft: emptyDraft };
    case 'saveFailed':
      return { ...state, saving: false, formError: action.error };
    case 'removeFailed':
      return { ...state, loadError: action.error };
  }
}

/** The skeleton shows until the first load answers, one way or the other. */
export function isLoading(state: ModelFormsState): boolean {
  return state.models === null && !state.loadError;
}

/** "No models configured yet" — only with the form closed. */
export function showsEmpty(state: ModelFormsState): boolean {
  return (state.models ?? []).length === 0 && state.editingId === null;
}

/** The row being edited, if the form is open on one. */
function editingRow(state: ModelFormsState): ModelRow | undefined {
  return state.editingId !== 'new'
    ? (state.models ?? []).find((row) => row.id === state.editingId)
    : undefined;
}

/**
 * Which stored config the listing (and a keyless save) can borrow a key
 * from: the reuse choice when one is made, else the row being edited —
 * its stored key is what a blank field means on save, so it is what the
 * list should answer for too.
 */
export function borrowFromId(state: ModelFormsState): string {
  const row = editingRow(state);
  return state.draft.apiKeyFromId || (row?.hasApiKey ? row.id : '');
}

/** Other configs whose stored key can be reused — the same connection serving another model row. */
export function keyedSiblings(state: ModelFormsState): ModelRow[] {
  return (state.models ?? []).filter((row) => row.hasApiKey && row.id !== state.editingId);
}

/** "List available models" needs a key to ask with: typed, borrowed, or stored on this row. */
export function canList(state: ModelFormsState): boolean {
  return Boolean(state.draft.apiKey || borrowFromId(state));
}

/** "Test connection" sends a chat completion: a key, a model id, and not an image model. */
export function canTest(state: ModelFormsState): boolean {
  return (
    canList(state) && Boolean(state.draft.model.trim()) && !isImageSurface(state.draft.apiSurface)
  );
}

/** What the draft's provider and surface put on the form. */
export interface FormView {
  /** Only the OpenAI dialect has an API surface to pick. */
  showsApiSurface: boolean;
  /** The image hint's flavour, or null on a chat surface. */
  imageSurface: 'images' | 'flux' | null;
  /** The Responses API opt-in hint: an OpenAI chat surface only. */
  showsResponsesHint: boolean;
  /** Which reasoning-effort hint: Claude's output_config.effort, or the GPT reasoning models'. */
  reasoningHint: 'anthropic' | 'openai';
  reasoningSuggestions: string[];
  /** The model id's suggestions: the provider's live answer once fetched, else the usual ids. */
  modelSuggestions: string[];
  /** The key field shows unless a stored key is being reused; a new model must have one. */
  showsKeyInput: boolean;
  keyRequired: boolean;
  /** Why "List available models" or "Test connection" is off, when it is for a missing input. */
  listMissing: boolean;
  testMissing: boolean;
  defaultBox: { checked: boolean; disabled: boolean };
}

export function formView(state: ModelFormsState): FormView {
  const { draft } = state;
  const image = isImageSurface(draft.apiSurface);
  const openai = draft.provider === 'openai';
  const anthropic = draft.provider === 'anthropic';
  return {
    showsApiSurface: openai,
    imageSurface: openai && image ? (draft.apiSurface === 'flux' ? 'flux' : 'images') : null,
    showsResponsesHint: openai && !image,
    reasoningHint: anthropic ? 'anthropic' : 'openai',
    // Claude takes output_config.effort, which has no "none" or "minimal".
    reasoningSuggestions: [
      ...(anthropic ? [] : ['none', 'minimal']),
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ],
    modelSuggestions: state.available
      ? state.available.map((entry) => entry.id)
      : (MODEL_SUGGESTIONS[draft.provider] ?? []),
    showsKeyInput: draft.apiKeyFromId === '',
    keyRequired: state.editingId === 'new' && draft.apiKeyFromId === '',
    listMissing: !canList(state),
    testMissing: !canTest(state) && !image,
    defaultBox: { checked: draft.isDefault && !image, disabled: image },
  };
}

/** The endpoint the List and Test requests reach. */
function connection(state: ModelFormsState) {
  const { draft } = state;
  return {
    provider: draft.provider,
    baseUrl: draft.baseUrl || null,
    ...(draft.apiVersion.trim() ? { apiVersion: draft.apiVersion.trim() } : {}),
  };
}

function keySource(state: ModelFormsState): { apiKey: string } | { modelConfigId: string } {
  // A typed key wins — it is what a save would store; otherwise the server
  // lends the borrowed config's stored key without it ever reaching the page.
  return state.draft.apiKey
    ? { apiKey: state.draft.apiKey }
    : { modelConfigId: borrowFromId(state) };
}

/** The body "List available models" posts to /api/admin/llm-models/available. */
export function listRequest(state: ModelFormsState): Record<string, unknown> {
  return { ...connection(state), ...keySource(state) };
}

/** The body "Test connection" posts to /api/admin/llm-models/test. */
export function testRequest(state: ModelFormsState): Record<string, unknown> {
  const { draft } = state;
  return {
    ...connection(state),
    model: draft.model,
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.apiSurface ? { apiSurface: draft.apiSurface } : {}),
    ...keySource(state),
  };
}

export type SaveRequest =
  | { ok: false; error: string }
  | { ok: true; method: 'POST' | 'PUT'; path: string; body: Record<string, unknown> };

/**
 * What Save sends — a new model POSTs, an edit PUTs to its row — or why
 * the form refuses to send it: a token count that is not one.
 */
export function saveRequest(state: ModelFormsState): SaveRequest {
  const { draft, editingId } = state;
  const contextWindow = draft.contextWindow.trim() ? parseTokenCount(draft.contextWindow) : null;
  if (draft.contextWindow.trim() && contextWindow === null) {
    return { ok: false, error: 'Context window must be a token count, such as 200k or 1m.' };
  }
  const maxOutputTokens = draft.maxOutputTokens.trim()
    ? parseTokenCount(draft.maxOutputTokens)
    : null;
  if (draft.maxOutputTokens.trim() && maxOutputTokens === null) {
    return { ok: false, error: 'Max output tokens must be a token count, such as 4k or 8000.' };
  }
  const body = {
    label: draft.label,
    provider: draft.provider,
    model: draft.model,
    baseUrl: draft.baseUrl || null,
    ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
    ...(contextWindow !== null ? { contextWindow } : {}),
    ...(draft.temperature ? { temperature: Number(draft.temperature) } : {}),
    ...(draft.apiVersion.trim() ? { apiVersion: draft.apiVersion.trim() } : {}),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.apiSurface ? { apiSurface: draft.apiSurface } : {}),
    ...(draft.dataResidency.trim() ? { dataResidency: draft.dataResidency.trim() } : {}),
    ...(draft.providerRetention ? { providerRetention: draft.providerRetention } : {}),
    baaCovered: draft.baaCovered,
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
    ...(draft.apiKeyFromId && !draft.apiKey ? { apiKeyFromId: draft.apiKeyFromId } : {}),
    enabled: draft.enabled,
    // An image model is never the default, whatever the draft held.
    isDefault: draft.isDefault && !isImageSurface(draft.apiSurface),
  };
  return editingId === 'new' || editingId === null
    ? { ok: true, method: 'POST', path: '/api/admin/llm-models', body }
    : { ok: true, method: 'PUT', path: `/api/admin/llm-models/${editingId}`, body };
}

/**
 * The roster's warning: no BAA recorded, or the retention left unknown.
 * Mirrors dataHandlingWarning in @renkei/agent-llm, which the server-side
 * gate reads; the wording here is what an operator sees on the row.
 */
export function dataHandlingWarningOf(row: ModelRow): string | null {
  if (row.settings?.baaCovered !== true) return 'Not BAA-covered';
  const retention = row.settings?.providerRetention;
  if (!retention || retention === 'unknown') return 'Retention unknown';
  return null;
}

/** What one roster row says about itself. */
export interface RowView {
  isDefault: boolean;
  imageGeneration: boolean;
  disabled: boolean;
  /** The data-handling warning badge, or null when a BAA and a retention term are recorded. */
  warning: string | null;
  keyStored: boolean;
}

export function rowView(row: ModelRow): RowView {
  return {
    isDefault: row.isDefault,
    imageGeneration: isImageSurface(row.settings?.apiSurface),
    disabled: !row.enabled,
    warning: dataHandlingWarningOf(row),
    keyStored: row.hasApiKey,
  };
}
