/**
 * The agent builder's state (agent-builder.tsx): the agent being written
 * (name, instructions, tools, triggers and the switches around them), the
 * trigger panel that is open, the "describe it" drafting box, the
 * worth-checking notes, and the save in flight.
 *
 * The component makes the calls (the draft job and its poll, the save, the
 * re-check), runs the timers, and dispatches what the person did and what
 * the server answered; everything the builder decides from that — what a
 * finished draft fills in and what it leaves alone, whether Save is on,
 * what Save and "Draft it for me" send, what a refused save leaves on
 * screen — is here, and tested in agent-builder.model.test.ts.
 */

import {
  instructionsSkeleton,
  isTriggerDraft,
  triggerVariableDescriptors,
  validateAgentDraft,
  type AgentDraft,
  type TriggerDraft,
  type ValidationIssue,
} from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import type { MintedApiKey, StoredAgent, TriggerPayload } from '@/lib/agents/store';
import { parseReviewNotes, type ReviewNote } from '@/lib/agents/notes';

/** The payload shape plus the read-only decorations a stored row carries. */
export type BuilderTrigger = TriggerPayload & {
  keyHint?: string | null;
  lastError?: string | null;
};

export type Selection = { type: 'trigger'; index: number } | { type: 'new-trigger' };

export type SaveModal = { stage: 'confirm' } | { stage: 'keys'; apiKeys: MintedApiKey[] };

export type ActApprovalPolicy = 'externally_triggered' | 'all' | 'off';

export interface SaveResponse {
  agentId?: string;
  apiKeys?: MintedApiKey[];
  descriptionPending?: boolean;
  agent?: StoredAgent;
  issues?: ValidationIssue[];
}

export interface BuilderState {
  /** null until the agent is first saved. */
  agentId: string | null;
  /** The builder never flips this: the agents list's toggle does. */
  enabled: boolean;
  name: string;
  instructions: string;
  tools: string[];
  triggers: BuilderTrigger[];
  llmModelId: string | null;
  guardrails: string;
  canAskQuestions: boolean;
  autoAcceptActions: boolean;
  selection: Selection | null;
  saving: boolean;
  /** What the server refused the last save with; shown instead of the local check. */
  serverIssues: ValidationIssue[];
  saveError: string | null;
  saveModal: SaveModal | null;
  checkNotes: ReviewNote[];
  checking: boolean;
  prose: string;
  proseOpen: boolean;
  drafting: boolean;
  draftError: string | null;
  draftDetail: string | null;
  draftSeconds: number;
  draftMode: 'create' | 'revise';
  /** The draft job being watched. */
  draftId: string | null;
  /** A draft that finished while the page was closed, offered — never applied unasked. */
  pendingDraft: { id: string; createdAt: string } | null;
  drafted: boolean;
  draftQuestions: string[];
  draftNotes: string[];
}

type Flag = 'canAskQuestions' | 'autoAcceptActions';

export type BuilderAction =
  | { type: 'nameChanged'; value: string }
  | { type: 'instructionsChanged'; value: string }
  | { type: 'guardrailsChanged'; value: string }
  | { type: 'toolsChanged'; tools: string[] }
  | { type: 'flagChanged'; flag: Flag; value: boolean }
  | { type: 'modelChanged'; llmModelId: string | null }
  | { type: 'sectionAdded'; heading: string }
  | { type: 'triggerAddOpened' }
  | { type: 'triggerOpened'; index: number }
  | { type: 'panelClosed' }
  | { type: 'triggerChosen'; draft: TriggerDraft }
  | { type: 'triggerEdited'; draft: TriggerDraft }
  | { type: 'triggerRemoved' }
  | { type: 'proseChanged'; value: string }
  | { type: 'proseOpened' }
  | { type: 'proseClosed' }
  /** "Draft it for me" went out. */
  | { type: 'draftStarted'; mode: 'create' | 'revise' }
  | { type: 'draftQueued'; draftId: string }
  | { type: 'draftStartFailed'; error: string | null }
  | { type: 'draftTick' }
  | { type: 'draftFailed'; error: string | null; detail: string | null }
  /** The watched draft finished; `localTimezone` reads a schedule that named none. */
  | { type: 'draftArrived'; result: Record<string, unknown>; localTimezone: string }
  | { type: 'pendingDraftFound'; draft: { id: string; createdAt: string } }
  | { type: 'pendingDraftDismissed' }
  | {
      type: 'pendingDraftLoaded';
      result: Record<string, unknown> | null;
      localTimezone: string;
    }
  | { type: 'recheckStarted' }
  | { type: 'recheckFailed'; error: string }
  | { type: 'recheckDone'; agent: StoredAgent | null }
  /** Update on an existing agent opens the confirm stage without saving. */
  | { type: 'confirmOpened' }
  | { type: 'modalClosed' }
  | { type: 'saveSent' }
  | { type: 'saveRefused'; issues: ValidationIssue[] }
  | { type: 'saveFailed'; error: string | null }
  | { type: 'saved'; response: SaveResponse };

function triggersOf(stored: StoredAgent['triggers']): BuilderTrigger[] {
  return stored.map((trigger) => ({
    id: trigger.id,
    draft: trigger.draft,
    enabled: trigger.enabled,
    keyHint: trigger.keyHint,
    lastError: trigger.lastError,
  }));
}

/** A new agent starts from the section skeleton with the describe box open. */
export function initBuilder(existing?: StoredAgent): BuilderState {
  return {
    agentId: existing?.id ?? null,
    enabled: existing?.enabled ?? false,
    name: existing?.name ?? '',
    instructions: existing?.instructions ?? instructionsSkeleton(),
    tools: existing?.tools ?? [],
    triggers: existing ? triggersOf(existing.triggers) : [],
    llmModelId: existing?.llmModelId ?? null,
    guardrails: existing?.guardrails ?? '',
    canAskQuestions: existing?.canAskQuestions ?? false,
    autoAcceptActions: existing?.autoAcceptActions ?? false,
    selection: null,
    saving: false,
    serverIssues: [],
    saveError: null,
    saveModal: null,
    checkNotes: parseReviewNotes(existing?.reviewNotes),
    checking: false,
    prose: '',
    // On edit the box REVISES the current instructions — a bigger act, behind a link.
    proseOpen: !existing,
    drafting: false,
    draftError: null,
    draftDetail: null,
    draftSeconds: 0,
    draftMode: 'create',
    draftId: null,
    pendingDraft: null,
    drafted: false,
    draftQuestions: [],
    draftNotes: [],
  };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

/** Whether a finished draft carries instructions the builder can use. */
export function isUsableDraft(result: Record<string, unknown> | null | undefined): boolean {
  return !!result && typeof result.instructions === 'string' && !!result.instructions.trim();
}

/**
 * A drafted agent put into the builder — the poll and the on-open offer
 * land identically. It replaces the instructions and tools, and only ever
 * fills what is empty: a name, a guardrails doc, triggers. It only ever
 * turns questions ON.
 */
function applyDraft(
  state: BuilderState,
  data: Record<string, unknown>,
  localTimezone: string
): BuilderState {
  const instructions = typeof data.instructions === 'string' ? data.instructions : '';
  let triggers = state.triggers;
  if (state.triggers.length === 0 && Array.isArray(data.triggers)) {
    // A drafted schedule with no stated timezone means "the prose never
    // said" — the person's own zone is the only sensible reading.
    const drafted = data.triggers.filter(isTriggerDraft);
    if (drafted.length > 0) {
      triggers = drafted.map((draft) => ({
        draft:
          draft.kind === 'schedule' && !draft.timezone
            ? { ...draft, timezone: localTimezone || 'UTC' }
            : draft,
        enabled: true,
      }));
    }
  }
  return {
    ...state,
    instructions,
    tools: stringsOf(data.tools),
    draftQuestions: stringsOf(data.questions),
    draftNotes: stringsOf(data.notes),
    guardrails:
      !state.guardrails.trim() && typeof data.guardrails === 'string'
        ? data.guardrails
        : state.guardrails,
    canAskQuestions: data.canAskQuestions === true ? true : state.canAskQuestions,
    name: !state.name.trim() && typeof data.name === 'string' && data.name ? data.name : state.name,
    triggers,
    drafted: true,
    serverIssues: [],
  };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'nameChanged':
      return { ...state, name: action.value };
    case 'instructionsChanged':
      return { ...state, instructions: action.value, serverIssues: [] };
    case 'guardrailsChanged':
      return { ...state, guardrails: action.value, serverIssues: [] };
    case 'toolsChanged':
      return { ...state, tools: action.tools, serverIssues: [] };
    case 'flagChanged':
      return { ...state, [action.flag]: action.value };
    case 'modelChanged':
      return { ...state, llmModelId: action.llmModelId };
    case 'sectionAdded':
      return {
        ...state,
        instructions: `${state.instructions.replace(/\s+$/, '')}\n\n## ${action.heading}\n\n`,
      };
    case 'triggerAddOpened':
      return { ...state, selection: { type: 'new-trigger' } };
    case 'triggerOpened':
      return { ...state, selection: { type: 'trigger', index: action.index } };
    case 'panelClosed':
      return { ...state, selection: null };
    case 'triggerChosen':
      return {
        ...state,
        triggers: [...state.triggers, { draft: action.draft, enabled: true }],
        selection: { type: 'trigger', index: state.triggers.length },
        serverIssues: [],
      };
    case 'triggerEdited': {
      const selection = state.selection;
      if (selection?.type !== 'trigger') return state;
      return {
        ...state,
        triggers: state.triggers.map((entry, at) =>
          at === selection.index ? { ...entry, draft: action.draft } : entry
        ),
      };
    }
    case 'triggerRemoved': {
      const selection = state.selection;
      if (selection?.type !== 'trigger') return state;
      return {
        ...state,
        triggers: state.triggers.filter((_, at) => at !== selection.index),
        selection: null,
      };
    }
    case 'proseChanged':
      return { ...state, prose: action.value };
    case 'proseOpened':
      return { ...state, proseOpen: true };
    case 'proseClosed':
      return { ...state, proseOpen: false };
    case 'draftStarted':
      return {
        ...state,
        draftMode: action.mode,
        drafting: true,
        draftSeconds: 0,
        draftError: null,
        draftDetail: null,
        draftQuestions: [],
        draftNotes: [],
      };
    case 'draftQueued':
      return { ...state, draftId: action.draftId };
    case 'draftStartFailed':
      return {
        ...state,
        drafting: false,
        draftError: action.error ?? 'Drafting could not be started — try again.',
      };
    case 'draftTick':
      return state.drafting ? { ...state, draftSeconds: state.draftSeconds + 1 } : state;
    case 'draftFailed':
      return {
        ...state,
        draftId: null,
        drafting: false,
        draftError: action.error ?? 'Drafting failed — try again.',
        draftDetail: action.detail ?? state.draftDetail,
      };
    case 'draftArrived': {
      const settled = { ...state, draftId: null, drafting: false };
      if (!isUsableDraft(action.result)) {
        return {
          ...settled,
          draftError: 'The draft came back in a shape this build does not understand.',
        };
      }
      return applyDraft(settled, action.result, action.localTimezone);
    }
    case 'pendingDraftFound':
      return { ...state, pendingDraft: action.draft };
    case 'pendingDraftDismissed':
      return { ...state, pendingDraft: null };
    case 'pendingDraftLoaded': {
      const settled = { ...state, pendingDraft: null };
      if (!action.result || !isUsableDraft(action.result)) {
        return { ...settled, draftError: 'That draft could not be loaded.' };
      }
      return applyDraft(settled, action.result, action.localTimezone);
    }
    case 'recheckStarted':
      return { ...state, checking: true };
    case 'recheckFailed':
      return { ...state, checking: false, saveError: action.error };
    case 'recheckDone':
      return {
        ...state,
        checking: false,
        checkNotes: action.agent ? parseReviewNotes(action.agent.reviewNotes) : state.checkNotes,
      };
    case 'confirmOpened':
      return { ...state, saveError: null, saveModal: { stage: 'confirm' } };
    case 'modalClosed':
      return { ...state, saveModal: null };
    case 'saveSent':
      return { ...state, saving: true, saveError: null };
    case 'saveRefused':
      // The server's issues render where the local ones would; the confirm stage closes on them.
      return { ...state, saving: false, serverIssues: action.issues, saveModal: null };
    case 'saveFailed':
      return {
        ...state,
        saving: false,
        saveError: action.error ?? 'The agent could not be saved.',
      };
    case 'saved': {
      const { response } = action;
      const agentId = response.agentId ?? response.agent?.id ?? state.agentId;
      const triggers = response.agent?.triggers
        ? triggersOf(response.agent.triggers)
        : state.triggers;
      const apiKeys = response.apiKeys ?? [];
      return {
        ...state,
        agentId,
        triggers,
        serverIssues: [],
        // Minted keys show once; otherwise `saving` stays on until the overview takes over.
        ...(apiKeys.length > 0
          ? { saving: false, saveModal: { stage: 'keys', apiKeys } }
          : { saving: true }),
      };
    }
  }
}

// ---------------------------------------------------------------- selectors

/** The agent as the shared validator and the server read it. */
export function agentDraftOf(state: BuilderState): AgentDraft {
  return {
    name: state.name,
    instructions: state.instructions,
    tools: state.tools,
    triggers: state.triggers.map((trigger) => trigger.draft),
    enabled: state.enabled,
    llmModelId: state.llmModelId,
    guardrails: state.guardrails.trim() ? state.guardrails : null,
    canAskQuestions: state.canAskQuestions,
    autoAcceptActions: state.autoAcceptActions,
  };
}

/** The same check the server treats as authority, run here only for inline hints. */
export function clientIssuesOf(state: BuilderState, tools: ToolDescriptor[]): ValidationIssue[] {
  return validateAgentDraft(agentDraftOf(state), tools);
}

/** What the fields show: the server's last refusal while it stands, else the local check. */
export function shownIssues(
  state: BuilderState,
  clientIssues: ValidationIssue[]
): ValidationIssue[] {
  return state.serverIssues.length > 0 ? state.serverIssues : clientIssues;
}

/** The messages for one field and everything under it (`tools` covers `tools.0`). */
export function issuesAt(issues: ValidationIssue[], prefix: string): string[] {
  return issues
    .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
    .map((issue) => issue.message);
}

/** Whether the instructions say anything beyond the starting skeleton. */
export function hasRealInstructions(state: BuilderState): boolean {
  const text = state.instructions.trim();
  return text !== '' && text !== instructionsSkeleton().trim();
}

/**
 * The instructions' messages. An untouched skeleton is where you start,
 * not an error: its missing-content issue still blocks Save, it just is
 * not shown in red.
 */
export function instructionIssuesOf(state: BuilderState, issues: ValidationIssue[]): string[] {
  return hasRealInstructions(state) || state.serverIssues.length > 0
    ? issuesAt(issues, 'instructions')
    : [];
}

/** Save is on once the local check passes and nothing is in flight. */
export function canSave(state: BuilderState, clientIssues: ValidationIssue[]): boolean {
  return !state.saving && clientIssues.length === 0;
}

export function saveLabel(state: BuilderState): string {
  if (state.saving) return 'Saving…';
  return state.agentId ? 'Update' : 'Save';
}

/** The line beside Save. */
export function saveSummary(state: BuilderState, issues: ValidationIssue[]): string {
  if (issues.length > 0) {
    return `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before saving`;
  }
  return state.enabled
    ? 'This agent is on.'
    : 'Saved agents start turned off — you review, then turn them on.';
}

/** Where Cancel, Done and a finished save go. */
export function overviewHref(agentId: string | null): string {
  return agentId ? `/agents/${agentId}` : '/agents';
}

/** Save on an existing agent asks first; a new one saves straight away. */
export function saveAsksFirst(state: BuilderState): boolean {
  return state.agentId !== null;
}

/** What Save sends: a create, or an update of the agent being edited. */
export function saveRequestOf(state: BuilderState): {
  url: string;
  method: 'POST' | 'PUT';
  body: Record<string, unknown>;
} {
  return {
    url: state.agentId ? `/api/agents/${state.agentId}` : '/api/agents',
    method: state.agentId ? 'PUT' : 'POST',
    body: {
      name: state.name,
      instructions: state.instructions,
      tools: state.tools,
      triggers: state.triggers,
      enabled: state.enabled,
      llmModelId: state.llmModelId,
      guardrails: state.guardrails.trim() ? state.guardrails : null,
      canAskQuestions: state.canAskQuestions,
      autoAcceptActions: state.autoAcceptActions,
      // Every save is content the owner may have changed — the summary is
      // rewritten in the background (see the PUT route).
      refreshDescription: true,
    },
  };
}

/** "Draft it for me" is on with ten characters to go on and no draft running. */
export function canDraft(state: BuilderState): boolean {
  return !state.drafting && state.prose.trim().length >= 10;
}

/**
 * What "Draft it for me" sends. With real instructions present it is a
 * REVISION (the component confirms first): they go along as context and
 * the model applies the described change. Triggers are suggested only
 * while none are configured.
 */
export function draftRequestOf(state: BuilderState): {
  revising: boolean;
  body: Record<string, unknown>;
} {
  const revising = hasRealInstructions(state);
  return {
    revising,
    body: {
      text: state.prose,
      guardrails: state.guardrails.trim() ? state.guardrails : null,
      current: revising ? { instructions: state.instructions, tools: state.tools } : null,
      ...(state.triggers.length === 0 ? { suggestTriggers: true } : {}),
      triggerVars: triggerValuesOf(state).map(({ name, description }) => ({ name, description })),
      ...(state.agentId ? { agentId: state.agentId } : {}),
    },
  };
}

export function draftButtonLabel(state: BuilderState): string {
  if (state.drafting) return 'Drafting…';
  return state.drafted ? 'Draft again' : 'Draft it for me';
}

/** What the drafting box says while the job runs, by how long it has been. */
export function draftStatus(state: Pick<BuilderState, 'draftSeconds' | 'draftMode'>): string {
  const seconds = state.draftSeconds;
  if (seconds < 3) return 'Sending your description to your org’s model…';
  if (seconds < 20) {
    return state.draftMode === 'revise'
      ? 'Revising the instructions — applying the change you described…'
      : 'Writing the instructions and picking the tools…';
  }
  return (
    `Still working (${seconds}s). This runs in the background — you can leave this page ` +
    'and the draft will be waiting when you come back.'
  );
}

/** What each run is handed by the agent's triggers — what the instructions can refer to. */
export function triggerValuesOf(state: BuilderState): { name: string; description: string }[] {
  return triggerVariableDescriptors(state.triggers.map((trigger) => trigger.draft));
}

/** The trigger whose editor is open, if one is. */
export function selectedTriggerOf(state: BuilderState): BuilderTrigger | null {
  return state.selection?.type === 'trigger'
    ? (state.triggers[state.selection.index] ?? null)
    : null;
}

/** Whether a `## Heading` for the section is present in the text. */
export function hasSection(instructions: string, heading: string): boolean {
  return new RegExp(`^##\\s+${heading}\\b`, 'mi').test(instructions);
}

/** The model picker's first option: the org default, named when there is one. */
export function defaultModelLabel(models: { label: string; isDefault: boolean }[]): string {
  const fallback = models.find((model) => model.isDefault);
  return `Organization default${fallback ? ` (${fallback.label})` : ''}`;
}

/** The copy beside the auto-accept switch: what it can and cannot skip. */
export function autoAcceptNote(policy: ActApprovalPolicy): string {
  const base =
    'Changes from high-risk tools (sending mail, deleting or sharing documents, merging code) always wait for you.';
  switch (policy) {
    case 'all':
      return `Your organization requires a person to accept every agent’s changes, so this has no effect right now. ${base}`;
    case 'off':
      return base;
    case 'externally_triggered':
      return `Runs started by an email, a message or an API call still wait for you — your organization requires it. ${base}`;
  }
}
