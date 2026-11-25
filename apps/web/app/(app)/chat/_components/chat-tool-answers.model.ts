/**
 * "Decided in this chat", in the chat's Tools dialog, with no React: the
 * tools the owner allowed or blocked for this one chat from its
 * permission card, and Reset, which puts one back to asking. It is the
 * only way out of "Block in this chat": a blocked tool is never offered
 * to the chat again, so it never raises a card to answer.
 *
 * Loaded each time the dialog opens (the card may have changed it since);
 * one reset at a time; a refused reset keeps the row and says why; the
 * server's answer replaces the list. chat-tool-answers.tsx renders from
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
  /** The tool a reset is on its way for. */
  resetting: string | null;
  error: string | null;
}

export type ChatToolAnswersAction =
  | { type: 'loaded'; answers: unknown }
  | { type: 'load-failed' }
  | { type: 'reset-started'; tool: string }
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
    case 'reset-succeeded':
      return { ...state, answers: read(action.answers), resetting: null, error: null };
    case 'reset-failed':
      return { ...state, resetting: null, error: action.error };
  }
}

export interface ChatToolAnswerRow {
  name: string;
  label: string;
  /** What was decided, as the row says it. */
  decided: 'Allowed in this chat' | 'Blocked in this chat';
  blocked: boolean;
  /** Reset's label right now, and whether it can be pressed. */
  reset: { label: string; disabled: boolean };
}

/** One row per decided tool, blocked ones first (they are what someone comes here to undo). */
export function chatToolAnswerRows(state: ChatToolAnswersState): ChatToolAnswerRow[] {
  if (!state.answers) return [];
  const row = (name: string, blocked: boolean): ChatToolAnswerRow => ({
    name,
    label: toolLabel(name),
    decided: blocked ? 'Blocked in this chat' : 'Allowed in this chat',
    blocked,
    reset: {
      label: state.resetting === name ? 'Resetting…' : 'Reset',
      disabled: state.resetting !== null,
    },
  });
  return [
    ...state.answers.deny.map((name) => row(name, true)),
    ...state.answers.allow.map((name) => row(name, false)),
  ];
}

/** Whether the section shows at all: only once loaded, and only with something decided. */
export function showsChatToolAnswers(state: ChatToolAnswersState): boolean {
  return chatToolAnswerRows(state).length > 0;
}
