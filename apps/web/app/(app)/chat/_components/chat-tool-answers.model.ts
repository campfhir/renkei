/**
 * "Decided in this chat", in the chat's Tools dialog, with no React: the
 * tools the owner allowed or blocked for this one chat from its
 * permission card, and Reset, which puts one back to asking. It is the
 * only way out of "Block in this chat": a blocked tool is never offered
 * to the chat again, so it never raises a card to answer.
 *
 * Short on purpose: an icon says blocked or allowed, the heading counts
 * them, each row has an undo button, and Reset all clears the lot (a chat
 * can collect a dozen blocks). Loaded each time the dialog opens (the card
 * may have changed it since); one reset at a time; a refused reset keeps
 * the rows and says why; the server's answer replaces the list. chat-tool-answers.tsx renders from
 * this; tested in chat-tool-answers.model.test.ts.
 */

import { toolLabel } from './message-list.model';

export interface ChatToolAnswersView {
  allow: string[];
  deny: string[];
}

export interface ChatToolAnswersState {
  /** null until loaded; the same shape the route answers. */
  answers: ChatToolAnswersView | null;
  failedToLoad: boolean;
  /** The tool a reset is on its way for, or ALL for Reset all. */
  resetting: string | null;
  error: string | null;
}

/** `resetting` while Reset all is on its way. */
export const ALL = '*';

export type ChatToolAnswersAction =
  | { type: 'loaded'; answers: unknown }
  | { type: 'load-failed' }
  | { type: 'reset-started'; tool: string }
  | { type: 'reset-all-started' }
  | { type: 'reset-succeeded'; answers: unknown }
  | { type: 'reset-failed'; error: string };

export const initialChatToolAnswersState: ChatToolAnswersState = {
  answers: null,
  failedToLoad: false,
  resetting: null,
  error: null,
};

function listOf(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string').sort()
    : [];
}

function read(raw: unknown): ChatToolAnswersView {
  if (typeof raw !== 'object' || raw === null) return { allow: [], deny: [] };
  return { allow: listOf(Reflect.get(raw, 'allow')), deny: listOf(Reflect.get(raw, 'deny')) };
}

export function chatToolAnswersReducer(
  state: ChatToolAnswersState,
  action: ChatToolAnswersAction
): ChatToolAnswersState {
  switch (action.type) {
    case 'loaded':
      return { ...state, answers: read(action.answers), failedToLoad: false };
    case 'load-failed':
      return { ...state, failedToLoad: true };
    case 'reset-started':
      return state.resetting ? state : { ...state, resetting: action.tool, error: null };
    case 'reset-all-started':
      return state.resetting ? state : { ...state, resetting: ALL, error: null };
    case 'reset-succeeded':
      return { ...state, answers: read(action.answers), resetting: null, error: null };
    case 'reset-failed':
      return { ...state, resetting: null, error: action.error };
  }
}

export interface ChatToolAnswerRow {
  name: string;
  label: string;
  blocked: boolean;
  /** This row's undo is on its way. */
  busy: boolean;
  /** Every undo is off while any reset is on its way. */
  disabled: boolean;
}

/** One row per decided tool, blocked ones first (they are what someone comes here to undo). */
export function chatToolAnswerRows(state: ChatToolAnswersState): ChatToolAnswerRow[] {
  if (!state.answers) return [];
  const row = (name: string, blocked: boolean): ChatToolAnswerRow => ({
    name,
    label: toolLabel(name),
    blocked,
    busy: state.resetting === name || state.resetting === ALL,
    disabled: state.resetting !== null,
  });
  return [
    ...state.answers.deny.map((name) => row(name, true)),
    ...state.answers.allow.map((name) => row(name, false)),
  ];
}

export interface ChatToolAnswerGroup {
  /** The tool names' shared prefix: `agent` for agent_create. */
  key: string;
  /** What the group's small heading says: "Agent". */
  label: string;
  rows: ChatToolAnswerRow[];
}

/** How a prefix reads as a heading; the names whose plain capitalisation is wrong. */
const PREFIX_LABELS: Record<string, string> = {
  github: 'GitHub',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  onenote: 'OneNote',
  webex: 'Webex',
  admanager: 'AD Manager',
};

/**
 * The rows grouped by the tools' prefix, so a short label stays plain
 * ("Create" under Agent and under Card are two different tools). Groups
 * in name order; within one, blocked first, as in the flat list.
 */
export function chatToolAnswerGroups(state: ChatToolAnswersState): ChatToolAnswerGroup[] {
  const groups = new Map<string, ChatToolAnswerRow[]>();
  for (const row of chatToolAnswerRows(state)) {
    const key = row.name.split('_')[0] || row.name;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, rows]) => ({
      key,
      label: PREFIX_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
      rows,
    }));
}

/** The heading's count: "12 blocked · 1 allowed", leaving out a zero. */
export function chatToolAnswersCount(state: ChatToolAnswersState): string {
  const blocked = state.answers?.deny.length ?? 0;
  const allowed = state.answers?.allow.length ?? 0;
  return [blocked > 0 ? `${blocked} blocked` : null, allowed > 0 ? `${allowed} allowed` : null]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Reset all: offered from two decisions up (one has its own undo), off while a reset is on its way. */
export function resetAllView(state: ChatToolAnswersState): { shown: boolean; disabled: boolean } {
  return {
    shown: chatToolAnswerRows(state).length > 1,
    disabled: state.resetting !== null,
  };
}

/** Whether the section shows at all: only once loaded, and only with something decided. */
export function showsChatToolAnswers(state: ChatToolAnswersState): boolean {
  return chatToolAnswerRows(state).length > 0;
}
