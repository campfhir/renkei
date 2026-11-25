/**
 * "Decided here", in the chat's Tools dialog, with no React: every
 * decision that applies to tools in this chat, in one list. A tool on
 * none of the lists asks every time, so it is not listed.
 *
 * Four decisions, each with its glyph: allowed here (one tick), always
 * allowed (two ticks), blocked here (do-not-enter), always blocked (the
 * solid hand). One row per tool, saying the decision that actually
 * applies, the way a turn reads them (start-turn.ts): a block beats an
 * allow, and this chat's answer beats the person's always-lists. A tool
 * the organization locks says so instead of "allowed": it asks whatever
 * was allowed.
 *
 * Reset takes that row's decision back to asking — off this chat's
 * lists, or off the person's own (every chat of theirs, as Preferences
 * would); the next decision down, if any, then shows. Loaded each time
 * the dialog opens; one reset at a time; a refused reset keeps the rows
 * and says why; the server's answer replaces the lists.
 * chat-tool-answers.tsx renders from this; tested beside it.
 */

import { toolLabel } from './message-list.model';

export interface ToolDecisionLists {
  chat: { allow: string[]; deny: string[] };
  always: { allow: string[]; deny: string[] };
  /** The listed tools the organization locks as high risk. */
  locked: string[];
}

export interface ChatToolAnswersState {
  /** null until loaded. */
  answers: ToolDecisionLists | null;
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

function pair(raw: unknown): { allow: string[]; deny: string[] } {
  if (typeof raw !== 'object' || raw === null) return { allow: [], deny: [] };
  return { allow: listOf(Reflect.get(raw, 'allow')), deny: listOf(Reflect.get(raw, 'deny')) };
}

function read(raw: unknown): ToolDecisionLists {
  if (typeof raw !== 'object' || raw === null) {
    return { chat: pair(null), always: pair(null), locked: [] };
  }
  return {
    chat: pair(Reflect.get(raw, 'chat')),
    always: pair(Reflect.get(raw, 'always')),
    locked: listOf(Reflect.get(raw, 'locked')),
  };
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

export type ToolDecision = 'blocked-here' | 'always-blocked' | 'allowed-here' | 'always-allowed';

/** What a row's tag says, and the glyph beside it. */
export const DECISION_TAGS: Record<
  ToolDecision | 'locked',
  { text: string; glyph: 'ban' | 'hand' | 'check' | 'double-check' | 'lock' }
> = {
  'blocked-here': { text: 'Blocked here', glyph: 'ban' },
  'always-blocked': { text: 'Always blocked', glyph: 'hand' },
  'allowed-here': { text: 'Allowed here', glyph: 'check' },
  'always-allowed': { text: 'Always allowed', glyph: 'double-check' },
  locked: { text: 'Locked · asks', glyph: 'lock' },
};

export interface ChatToolAnswerRow {
  name: string;
  label: string;
  decision: ToolDecision;
  /** The organization locks it: an allow does nothing, it asks. */
  locked: boolean;
  /** The tag: the decision's, or "Locked · asks" for an allowed tool that is locked. */
  tag: { text: string; glyph: 'ban' | 'hand' | 'check' | 'double-check' | 'lock' };
  blocked: boolean;
  /** Which list Reset takes it off. */
  scope: 'chat' | 'always';
  /** This row's Reset is on its way; every Reset is off while any is. */
  busy: boolean;
  disabled: boolean;
}

/** The decision that applies to a tool, as a turn reads them; null when it asks. */
function decisionFor(lists: ToolDecisionLists, name: string): ToolDecision | null {
  if (lists.chat.deny.includes(name)) return 'blocked-here';
  if (lists.always.deny.includes(name)) return 'always-blocked';
  if (lists.chat.allow.includes(name)) return 'allowed-here';
  if (lists.always.allow.includes(name)) return 'always-allowed';
  return null;
}

const ORDER: ToolDecision[] = ['blocked-here', 'always-blocked', 'allowed-here', 'always-allowed'];

/** One row per decided tool: blocks first (what someone comes here to undo), here before always. */
export function chatToolAnswerRows(state: ChatToolAnswersState): ChatToolAnswerRow[] {
  const lists = state.answers;
  if (!lists) return [];
  const names = [
    ...new Set([
      ...lists.chat.deny,
      ...lists.always.deny,
      ...lists.chat.allow,
      ...lists.always.allow,
    ]),
  ];
  return names
    .flatMap((name): ChatToolAnswerRow[] => {
      const decision = decisionFor(lists, name);
      if (!decision) return [];
      const blocked = decision === 'blocked-here' || decision === 'always-blocked';
      const locked = !blocked && lists.locked.includes(name);
      return [
        {
          name,
          label: toolLabel(name),
          decision,
          locked,
          tag: DECISION_TAGS[locked ? 'locked' : decision],
          blocked,
          scope: decision === 'blocked-here' || decision === 'allowed-here' ? 'chat' : 'always',
          busy: state.resetting === name,
          disabled: state.resetting !== null,
        },
      ];
    })
    .sort(
      (a, b) =>
        ORDER.indexOf(a.decision) - ORDER.indexOf(b.decision) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
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
 * in name order; within one, in the flat list's order.
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
  const rows = chatToolAnswerRows(state);
  const blocked = rows.filter((row) => row.blocked).length;
  const allowed = rows.length - blocked;
  return [blocked > 0 ? `${blocked} blocked` : null, allowed > 0 ? `${allowed} allowed` : null]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Whether the section shows at all: only once loaded, and only with something decided. */
export function showsChatToolAnswers(state: ChatToolAnswersState): boolean {
  return chatToolAnswerRows(state).length > 0;
}
