/**
 * "Permissions", in the chat's Tools dialog, with no React: every
 * decision that applies to tools in this chat, in one list, and a way to
 * block any tool the chat can be offered — one that only reads included,
 * which never asks and so is never offered a card. A tool on none of the
 * lists asks every time (or, if it only reads, simply runs), so it is not
 * listed.
 *
 * Four decisions, each with its glyph: allowed here (one tick), always
 * allowed (two ticks), blocked here (do-not-enter), always blocked (the
 * solid hand). One row per tool, saying the decision that actually
 * applies, the way a turn reads them (start-turn.ts): a block beats an
 * allow, and this chat's answer beats the person's always-lists. A tool
 * the organization locks says so instead of "allowed": it asks whatever
 * was allowed.
 *
 * Each tag explains itself in a tip floating beside it, on hover or
 * pressed (pressing pins it; one pinned at a time). Reset takes that
 * row's decision back — off this chat's lists, or off the person's own
 * (every chat of theirs, as Preferences would); the next decision down,
 * if any, then shows. "Block a tool" is a small dialog of its own: search
 * the chat's tools, pick one, choose this chat or every chat, Save — and
 * the tool joins the list. Loaded each time the dialog opens; one change at a
 * time; a refused change keeps the rows and says why; the server's answer
 * replaces the lists.
 * chat-tool-answers.tsx renders from this; tested beside it.
 */

import type { ActToolGroup } from '@/lib/chat/permission-rules';
import { toolLabel } from './message-list.model';

export interface ToolDecisionLists {
  chat: { allow: string[]; deny: string[] };
  always: { allow: string[]; deny: string[] };
  /** The listed tools the organization locks as high risk. */
  locked: string[];
  /** The tools the chat can be offered, by connector; reading ones carry `read`. */
  tools: ActToolGroup[];
}

export interface ChatToolAnswersState {
  /** null until loaded. */
  answers: ToolDecisionLists | null;
  failedToLoad: boolean;
  /** The tool a change (a reset or a block) is on its way for. */
  resetting: string | null;
  error: string | null;
  /** The row whose tag's explanation is open. */
  explaining: string | null;
  /** "Block a tool", its own small dialog: open or shut, the search, the tool picked, where. */
  picker: { open: boolean; filter: string; selected: string | null; scope: 'chat' | 'always' };
}

export type ChatToolAnswersAction =
  | { type: 'loaded'; answers: unknown }
  | { type: 'load-failed' }
  | { type: 'reset-started'; tool: string }
  | { type: 'block-started'; tool: string }
  | { type: 'reset-succeeded'; answers: unknown }
  | { type: 'reset-failed'; error: string }
  | { type: 'explain'; tool: string }
  | { type: 'picker-opened' }
  | { type: 'picker-closed' }
  | { type: 'picker-filter'; filter: string }
  | { type: 'picker-select'; tool: string }
  | { type: 'picker-scope'; scope: 'chat' | 'always' };

const CLOSED_PICKER: ChatToolAnswersState['picker'] = {
  open: false,
  filter: '',
  selected: null,
  scope: 'chat',
};

export const initialChatToolAnswersState: ChatToolAnswersState = {
  answers: null,
  failedToLoad: false,
  resetting: null,
  error: null,
  explaining: null,
  picker: CLOSED_PICKER,
};

function groupsOf(raw: unknown): ActToolGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((group): ActToolGroup[] => {
    if (typeof group !== 'object' || group === null) return [];
    const key: unknown = Reflect.get(group, 'key');
    const label: unknown = Reflect.get(group, 'label');
    const tools: unknown = Reflect.get(group, 'tools');
    if (typeof key !== 'string' || typeof label !== 'string' || !Array.isArray(tools)) return [];
    return [
      {
        key,
        label,
        tools: tools.flatMap((tool) => {
          if (typeof tool !== 'object' || tool === null) return [];
          const name: unknown = Reflect.get(tool, 'name');
          const toolLabelText: unknown = Reflect.get(tool, 'label');
          if (typeof name !== 'string') return [];
          return [
            {
              name,
              label: typeof toolLabelText === 'string' ? toolLabelText : name,
              ...(Reflect.get(tool, 'read') === true ? { read: true as const } : {}),
            },
          ];
        }),
      },
    ];
  });
}

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
    return { chat: pair(null), always: pair(null), locked: [], tools: [] };
  }
  return {
    chat: pair(Reflect.get(raw, 'chat')),
    always: pair(Reflect.get(raw, 'always')),
    locked: listOf(Reflect.get(raw, 'locked')),
    tools: groupsOf(Reflect.get(raw, 'tools')),
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
    case 'block-started':
      return state.resetting ? state : { ...state, resetting: action.tool, error: null };
    case 'reset-succeeded':
      return {
        ...state,
        answers: read(action.answers),
        resetting: null,
        error: null,
        explaining: null,
        // A block that went through closes its dialog: the tool is in the list now.
        picker: CLOSED_PICKER,
      };
    case 'reset-failed':
      return { ...state, resetting: null, error: action.error };
    case 'explain':
      return { ...state, explaining: state.explaining === action.tool ? null : action.tool };
    case 'picker-opened':
      return { ...state, picker: { ...CLOSED_PICKER, open: true }, error: null };
    case 'picker-closed':
      return { ...state, picker: CLOSED_PICKER };
    case 'picker-filter':
      return { ...state, picker: { ...state.picker, filter: action.filter } };
    case 'picker-select':
      return { ...state, picker: { ...state.picker, selected: action.tool } };
    case 'picker-scope':
      return { ...state, picker: { ...state.picker, scope: action.scope } };
  }
}

export type ToolDecision = 'blocked-here' | 'always-blocked' | 'allowed-here' | 'always-allowed';

export type TagGlyph = 'ban' | 'hand' | 'check' | 'double-check' | 'lock';

/** What a row's tag says, the glyph beside it, and what it means (its tooltip and explanation). */
export const DECISION_TAGS: Record<
  ToolDecision | 'locked',
  { text: string; glyph: TagGlyph; meaning: string }
> = {
  'blocked-here': {
    text: 'Blocked here',
    glyph: 'ban',
    meaning: 'Refused in this chat: if the model calls it here, the call is turned down.',
  },
  'always-blocked': {
    text: 'Always blocked',
    glyph: 'hand',
    meaning: 'Refused in every chat: the model can never use it anywhere in Renkei.',
  },
  'allowed-here': {
    text: 'Allowed here',
    glyph: 'check',
    meaning: 'In this chat the model calls it without waiting for you to allow it.',
  },
  'always-allowed': {
    text: 'Always allowed',
    glyph: 'double-check',
    meaning: 'In every chat in Renkei the model calls it without waiting for you to allow it.',
  },
  locked: {
    text: 'Locked · asks',
    glyph: 'lock',
    meaning:
      'Your organization locks this tool as high risk: it asks every time, whatever you allowed.',
  },
};

export interface ChatToolAnswerRow {
  name: string;
  label: string;
  decision: ToolDecision;
  /** The organization locks it: an allow does nothing, it asks. */
  locked: boolean;
  /** The tag: the decision's, or "Locked · asks" for an allowed tool that is locked. */
  tag: { text: string; glyph: TagGlyph; meaning: string };
  /** The tag's explanation is open under the row. */
  explained: boolean;
  blocked: boolean;
  /** Which list Reset takes it off. */
  scope: 'chat' | 'always';
  /** This row's Reset is on its way; every Reset is off while any is. */
  busy: boolean;
  disabled: boolean;
}

/** A tool's name as the catalog words it, else as the thread does. */
function labelOf(lists: ToolDecisionLists, name: string): string {
  for (const group of lists.tools) {
    const found = group.tools.find((tool) => tool.name === name);
    if (found) return found.label;
  }
  return toolLabel(name);
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
          label: labelOf(lists, name),
          decision,
          locked,
          tag: DECISION_TAGS[locked ? 'locked' : decision],
          blocked,
          scope: decision === 'blocked-here' || decision === 'allowed-here' ? 'chat' : 'always',
          explained: state.explaining === name,
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

/** Whether the section shows at all: once loaded (it always offers "Block a tool"). */
export function showsChatToolAnswers(state: ChatToolAnswersState): boolean {
  return state.answers !== null;
}

/** The most "Block a tool" lists at once; typing narrows it. */
export const PICKER_LIMIT = 40;

export interface PickerGroup {
  key: string;
  label: string;
  tools: { name: string; label: string; read: boolean; selected: boolean }[];
}

/**
 * What "Block a tool" offers: the chat's tools no block already covers
 * (an allowed one can still be blocked), matching the search by name or
 * connector, by connector, at most PICKER_LIMIT tools.
 */
export function pickerGroups(state: ChatToolAnswersState): {
  groups: PickerGroup[];
  more: number;
} {
  const lists = state.answers;
  if (!lists) return { groups: [], more: 0 };
  const blocked = new Set([...lists.chat.deny, ...lists.always.deny]);
  const needle = state.picker.filter.trim().toLowerCase();
  let shown = 0;
  let more = 0;
  const groups: PickerGroup[] = [];
  for (const group of lists.tools) {
    const groupMatches = needle !== '' && group.label.toLowerCase().includes(needle);
    const tools = group.tools.filter(
      (tool) =>
        !blocked.has(tool.name) &&
        (needle === '' ||
          groupMatches ||
          tool.label.toLowerCase().includes(needle) ||
          tool.name.toLowerCase().includes(needle))
    );
    const room = Math.max(0, PICKER_LIMIT - shown);
    more += Math.max(0, tools.length - room);
    const kept = tools.slice(0, room);
    shown += kept.length;
    if (kept.length > 0) {
      groups.push({
        key: group.key,
        label: group.label,
        tools: kept.map((tool) => ({
          name: tool.name,
          label: tool.label,
          read: tool.read === true,
          selected: state.picker.selected === tool.name,
        })),
      });
    }
  }
  return { groups, more };
}

/** The Block dialog's Save: on once a tool is picked, off while a change is on its way. */
export function blockSave(state: ChatToolAnswersState): { disabled: boolean; label: string } {
  return {
    disabled: state.picker.selected === null || state.resetting !== null,
    label:
      state.resetting !== null && state.resetting === state.picker.selected ? 'Saving…' : 'Save',
  };
}
