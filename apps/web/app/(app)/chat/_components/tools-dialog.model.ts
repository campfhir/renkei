/**
 * The Tools dialog (tools-dialog.tsx): which connectors a chat, a project
 * or a new code project may use. The dialog loads the person's catalog
 * and their saved defaults, makes the calls and dispatches what the
 * person did and what the server answered; what it decides from that is
 * here, and tested in tools-dialog.model.test.ts:
 *
 * - which boxes are checked when nothing is chosen — the chain the server
 *   follows (tool-config.ts's effectiveToolConfig): the chat's own list,
 *   else its project's toolset, else the person's default for this kind,
 *   else the built-in set (core for a chat, the code default for code);
 *   connectors the project requires (`locked`) are always checked;
 * - what a toggle hands the caller (the whole list, sorted) and what
 *   "Save as my default" sends;
 * - what the search shows, and which required connectors are missing;
 * - the explanation, and what the footer offers.
 */

import type { ConnectorOption } from '@/lib/chat/tool-surface';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';

/** Catalog label for a capability key, falling back to the key itself. */
export function connectorLabel(key: string): string {
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === key)?.label ?? key;
}

/** What the dialog is given by the page that holds it. */
export interface ToolsDialogProps {
  /** The chat's (or project's) own list; null = nothing chosen. */
  selected: string[] | null;
  context: 'chat' | 'project';
  kind: 'chat' | 'code';
  /** Offer the personal-default actions whatever the context. */
  saveDefault?: boolean;
  /** The chat's project's toolset; null outside a project or when it has none. */
  projectDefault: string[] | null;
  /** Connectors always on here (a code project's code hosts). */
  locked: readonly string[];
}

/** GET /api/chat/tools, as the dialog reads it. */
export interface ConnectorsAnswer {
  connectors: ConnectorOption[];
  core: string[];
  codeDefault?: string[];
  userDefault: { connectors: string[] } | null;
  userCodeDefault?: { connectors: string[] } | null;
}

export interface ToolsDialogState {
  /** null until the catalog answers; empty when it failed or is empty. */
  options: ConnectorOption[] | null;
  core: string[];
  codeDefault: string[];
  userDefault: string[] | null;
  userCodeDefault: string[] | null;
  savingDefault: boolean;
  savedWord: string | null;
  filter: string;
}

export type ToolsDialogAction =
  | { type: 'connectorsLoaded'; answer: ConnectorsAnswer }
  | { type: 'connectorsFailed' }
  | { type: 'filterChanged'; filter: string }
  /** The dialog closed: the search and the "Saved" word were for that opening. */
  | { type: 'closed' }
  | { type: 'saveDefaultStarted' }
  /** PUT answered; `connectors` is what it says the default now is (null on failure). */
  | { type: 'saveDefaultAnswered'; kind: 'chat' | 'code'; ok: boolean; connectors: string[] | null }
  | { type: 'clearDefaultStarted' }
  | { type: 'clearDefaultAnswered'; kind: 'chat' | 'code' };

export function initialToolsDialogState(): ToolsDialogState {
  return {
    options: null,
    core: [],
    codeDefault: [],
    userDefault: null,
    userCodeDefault: null,
    savingDefault: false,
    savedWord: null,
    filter: '',
  };
}

function withPersonal(
  state: ToolsDialogState,
  kind: 'chat' | 'code',
  connectors: string[] | null
): ToolsDialogState {
  return kind === 'code'
    ? { ...state, userCodeDefault: connectors }
    : { ...state, userDefault: connectors };
}

export function toolsDialogReducer(
  state: ToolsDialogState,
  action: ToolsDialogAction
): ToolsDialogState {
  switch (action.type) {
    case 'connectorsLoaded':
      return {
        ...state,
        options: action.answer.connectors,
        core: action.answer.core,
        codeDefault: action.answer.codeDefault ?? [],
        userDefault: action.answer.userDefault?.connectors ?? null,
        userCodeDefault: action.answer.userCodeDefault?.connectors ?? null,
      };
    case 'connectorsFailed':
      return { ...state, options: [] };
    case 'filterChanged':
      return { ...state, filter: action.filter };
    case 'closed':
      return { ...state, filter: '', savedWord: null };
    case 'saveDefaultStarted':
    case 'clearDefaultStarted':
      return { ...state, savingDefault: true, savedWord: null };
    case 'saveDefaultAnswered':
      if (!action.ok) return { ...state, savingDefault: false };
      return {
        ...withPersonal(state, action.kind, action.connectors),
        savingDefault: false,
        savedWord: 'Saved as your default.',
      };
    case 'clearDefaultAnswered':
      // Cleared on screen whatever the answer, as the dialog always has.
      return {
        ...withPersonal(state, action.kind, null),
        savingDefault: false,
        savedWord: 'Your default is cleared.',
      };
  }
}

/** Whether the catalog has to be fetched: the dialog is open and nothing has loaded. */
export function needsConnectors(state: ToolsDialogState, open: boolean): boolean {
  return open && state.options === null;
}

/** The person's saved default for this kind of chat. */
export function personalDefault(state: ToolsDialogState, props: ToolsDialogProps): string[] | null {
  return props.kind === 'code' ? state.userCodeDefault : state.userDefault;
}

/** What applies when nothing is chosen: project ?? personal ?? built-in. */
export function fallbackTools(state: ToolsDialogState, props: ToolsDialogProps): string[] {
  return (
    props.projectDefault ??
    personalDefault(state, props) ??
    (props.kind === 'code' ? state.codeDefault : state.core)
  );
}

/** The boxes that show checked. */
export function effectiveTools(state: ToolsDialogState, props: ToolsDialogProps): Set<string> {
  return new Set([...(props.selected ?? fallbackTools(state, props)), ...props.locked]);
}

/** What a toggle hands the caller: the whole list it pins on the chat, sorted. */
export function toggledTools(
  state: ToolsDialogState,
  props: ToolsDialogProps,
  key: string,
  checked: boolean
): string[] {
  const next = effectiveTools(state, props);
  if (checked) next.add(key);
  else next.delete(key);
  return [...next].sort();
}

/** What "Save as my default" sends: what shows checked, sorted. */
export function saveDefaultConnectors(state: ToolsDialogState, props: ToolsDialogProps): string[] {
  return [...effectiveTools(state, props)].sort();
}

/** Whether a row is a required connector, shown checked and disabled. */
export function isLocked(props: ToolsDialogProps, key: string): boolean {
  return props.locked.includes(key);
}

/**
 * Required connectors the person has not linked: nothing in the catalog
 * for them, so they are listed apart, with where to link them.
 */
export function missingLocked(state: ToolsDialogState, props: ToolsDialogProps): string[] {
  const options = state.options;
  if (options === null) return [];
  return props.locked.filter((key) => !options.some((option) => option.key === key));
}

/** The rows the search leaves, by label or key, any case; null while loading. */
export function shownOptions(state: ToolsDialogState): ConnectorOption[] | null {
  if (!state.options) return null;
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return state.options;
  return state.options.filter(
    (option) =>
      connectorLabel(option.key).toLowerCase().includes(needle) ||
      option.key.toLowerCase().includes(needle)
  );
}

/** What the list box shows. */
export type ToolsListView =
  | { kind: 'loading' }
  | { kind: 'nothing-connected' }
  | { kind: 'no-match'; filter: string }
  | { kind: 'rows'; rows: ConnectorOption[] };

export function listView(state: ToolsDialogState): ToolsListView {
  if (state.options === null) return { kind: 'loading' };
  if (state.options.length === 0) return { kind: 'nothing-connected' };
  const shown = shownOptions(state) ?? [];
  if (shown.length === 0) return { kind: 'no-match', filter: state.filter.trim() };
  return { kind: 'rows', rows: shown };
}

/** Whether the catalog has anything in it (the search box and default actions need it). */
export function hasConnectors(state: ToolsDialogState): boolean {
  return state.options !== null && state.options.length > 0;
}

/** The count on the trigger: how many the chat has pinned, none when nothing is chosen. */
export function triggerCount(props: ToolsDialogProps): number | null {
  return props.selected ? props.selected.length : null;
}

/** The line above the list. */
export function explanation(props: ToolsDialogProps): string {
  if (props.context === 'project') {
    return props.kind === 'code'
      ? 'Connectors chats in this project start with, unless a chat picks its own — from your default for code projects, or the code default.'
      : 'Connectors chats in this project start with, unless a chat picks its own.';
  }
  if (props.kind === 'code') {
    return 'Connectors the assistant may use in this chat. A code project’s chat starts from the project’s toolset, else your default for code projects, else the code default.';
  }
  return props.projectDefault
    ? 'Connectors the assistant may use in this chat. Starts from this project’s toolset, unless you pick your own.'
    : 'Connectors the assistant may use in this chat.';
}

/** What the footer offers. */
export interface ToolsFooter {
  /** "Reset to defaults": only once something is chosen. */
  reset: boolean;
  /** "Save as my default" (and its label), when the personal default is offered here. */
  save: { label: string; disabled: boolean } | null;
  /** "Clear my default", when one is saved. */
  clear: { disabled: boolean } | null;
  /** In a project's own dialog: "saved on the project as you toggle". */
  projectNote: boolean;
}

export function footer(state: ToolsDialogState, props: ToolsDialogProps): ToolsFooter {
  const offersDefault = props.saveDefault ?? props.context === 'chat';
  const any = hasConnectors(state);
  const offer = offersDefault && any;
  return {
    reset: props.selected !== null,
    save: offer
      ? {
          label: state.savingDefault
            ? 'Saving…'
            : props.kind === 'code'
              ? 'Save as my default for code projects'
              : 'Save as my default',
          disabled: state.savingDefault,
        }
      : null,
    clear: offer && personalDefault(state, props) ? { disabled: state.savingDefault } : null,
    projectNote: props.context === 'project' && !offersDefault && any,
  };
}
