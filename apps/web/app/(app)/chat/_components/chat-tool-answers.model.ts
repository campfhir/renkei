/**
 * "Permissions", in the chat's Tools dialog, with no React: every tool
 * something has been decided for in this chat, one row each, saying the
 * decision that applies and which layer made it — the same rule a turn
 * follows (lib/chat/tool-decision.ts): blocked here or always, locked by
 * the organization, this chat's Ask or Allow, the project's Ask or Allow,
 * the person's always-allow for this kind of chat. A tool nothing decides
 * is not listed: an act tool asks, a read tool runs.
 *
 * Each row's tag explains itself in a tip floating beside it (hover, or
 * press to pin). Reset takes back a decision this chat or the person made
 * (the project's are changed in the project's settings, the
 * organization's on Settings). "Set a tool" is a small dialog of its own:
 * pick a tool, choose this chat (Allow an act tool, make a read tool Ask,
 * or Block) or every chat of this kind (Allow or Block), Save — the tool
 * then shows in the list. Allowing a tool the organization locks is not
 * offered. Loaded each time the dialog opens; one change at a time; a
 * refused change keeps the rows and says why; the server's answer
 * replaces the lists. chat-tool-answers.tsx renders from this.
 */

import type { ActToolGroup, ChatSessionKind } from '@/lib/chat/permission-rules';
import { decidedBy, type DecidedBy, type ToolLayers } from '@/lib/chat/tool-decision';
import { toolLabel } from './message-list.model';

export interface ToolLayerLists {
  kind: ChatSessionKind;
  chat: { allow: string[]; deny: string[]; ask: string[] };
  project: { name: string; allow: string[]; ask: string[] } | null;
  always: { allow: string[]; deny: string[] };
  locked: string[];
  tools: ActToolGroup[];
}

export type SetScope = 'chat' | 'always';
export type SetRule = 'allow' | 'ask' | 'deny';

export interface ChatToolAnswersState {
  /** null until loaded. */
  answers: ToolLayerLists | null;
  failedToLoad: boolean;
  /** The tool a change is on its way for. */
  resetting: string | null;
  error: string | null;
  /** The row whose tip is pinned open. */
  explaining: string | null;
  /** "Set a tool", its own small dialog. */
  picker: {
    open: boolean;
    filter: string;
    selected: string | null;
    choice: { scope: SetScope; rule: SetRule } | null;
  };
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
  | { type: 'picker-choice'; scope: SetScope; rule: SetRule };

const CLOSED_PICKER: ChatToolAnswersState['picker'] = {
  open: false,
  filter: '',
  selected: null,
  choice: null,
};

export const initialChatToolAnswersState: ChatToolAnswersState = {
  answers: null,
  failedToLoad: false,
  resetting: null,
  error: null,
  explaining: null,
  picker: CLOSED_PICKER,
};

function listOf(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((entry): entry is string => typeof entry === 'string'))].sort()
    : [];
}

function field(raw: unknown, key: string): unknown {
  return typeof raw === 'object' && raw !== null ? Reflect.get(raw, key) : undefined;
}

function groupsOf(raw: unknown): ActToolGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((group): ActToolGroup[] => {
    const key = field(group, 'key');
    const label = field(group, 'label');
    const tools = field(group, 'tools');
    if (typeof key !== 'string' || typeof label !== 'string' || !Array.isArray(tools)) return [];
    return [
      {
        key,
        label,
        tools: tools.flatMap((tool) => {
          const name = field(tool, 'name');
          const text = field(tool, 'label');
          if (typeof name !== 'string') return [];
          return [
            {
              name,
              label: typeof text === 'string' ? text : name,
              ...(field(tool, 'read') === true ? { read: true as const } : {}),
            },
          ];
        }),
      },
    ];
  });
}

function read(raw: unknown): ToolLayerLists {
  const kind = field(raw, 'kind');
  const project = field(raw, 'project');
  const projectName = field(project, 'name');
  return {
    kind: kind === 'project' || kind === 'code' ? kind : 'chat',
    chat: {
      allow: listOf(field(field(raw, 'chat'), 'allow')),
      deny: listOf(field(field(raw, 'chat'), 'deny')),
      ask: listOf(field(field(raw, 'chat'), 'ask')),
    },
    project:
      typeof projectName === 'string'
        ? {
            name: projectName,
            allow: listOf(field(project, 'allow')),
            ask: listOf(field(project, 'ask')),
          }
        : null,
    always: {
      allow: listOf(field(field(raw, 'always'), 'allow')),
      deny: listOf(field(field(raw, 'always'), 'deny')),
    },
    locked: listOf(field(raw, 'locked')),
    tools: groupsOf(field(raw, 'tools')),
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
        // A change that went through closes its dialog: the tool is in the list now.
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
      // A new tool may not take the choice the last one had (Ask is for reading tools).
      return { ...state, picker: { ...state.picker, selected: action.tool, choice: null } };
    case 'picker-choice':
      return {
        ...state,
        picker: { ...state.picker, choice: { scope: action.scope, rule: action.rule } },
      };
  }
}

/** The layers as the rule reads them. */
export function layersOf(lists: ToolLayerLists): ToolLayers {
  return {
    locked: new Set(lists.locked),
    user: { allow: new Set(lists.always.allow), deny: new Set(lists.always.deny) },
    project: lists.project
      ? { allow: new Set(lists.project.allow), ask: new Set(lists.project.ask) }
      : null,
    session: {
      allow: new Set(lists.chat.allow),
      deny: new Set(lists.chat.deny),
      ask: new Set(lists.chat.ask),
    },
    auto: null,
  };
}

export type TagGlyph = 'ban' | 'hand' | 'check' | 'double-check' | 'lock' | 'question';
export type TagTone = 'blocked' | 'asks' | 'allowed';

/** What "always" reaches from this kind of chat. */
export function kindPhrase(kind: ChatSessionKind): string {
  return kind === 'project'
    ? 'every chat in a chat project'
    : kind === 'code'
      ? 'every code project chat'
      : 'every chat';
}

/** A row's tag: what it says, its glyph, its tone, and what it means (its tip). */
export function tagFor(
  by: Exclude<DecidedBy, 'default'>,
  kind: ChatSessionKind,
  projectName: string | null
): { text: string; glyph: TagGlyph; tone: TagTone; meaning: string } {
  const every = kindPhrase(kind);
  const project = projectName ? `“${projectName}”` : 'The project';
  switch (by) {
    case 'blocked-here':
      return {
        text: 'Blocked here',
        glyph: 'ban',
        tone: 'blocked',
        meaning: 'Refused in this chat: if the model calls it here, the call is turned down.',
      };
    case 'always-blocked':
      return {
        text: 'Always blocked',
        glyph: 'hand',
        tone: 'blocked',
        meaning: `Refused in ${every}: the model can never use it there.`,
      };
    case 'locked':
      return {
        text: 'Locked · asks',
        glyph: 'lock',
        tone: 'asks',
        meaning:
          'Your organization locks this tool as high risk: it asks every time, whatever is allowed.',
      };
    case 'ask-here':
      return {
        text: 'Asks here',
        glyph: 'question',
        tone: 'asks',
        meaning: 'In this chat it waits for you to allow it before it runs.',
      };
    case 'allowed-here':
      return {
        text: 'Allowed here',
        glyph: 'check',
        tone: 'allowed',
        meaning: 'In this chat the model calls it without waiting for you to allow it.',
      };
    case 'project-ask':
      return {
        text: 'Project asks',
        glyph: 'question',
        tone: 'asks',
        meaning: `${project} makes it wait for you before it runs in its chats. This chat can still block it.`,
      };
    case 'project-allow':
      return {
        text: 'Project allows',
        glyph: 'check',
        tone: 'allowed',
        meaning: `${project} lets it run without asking in its chats. This chat can still make it ask, or block it.`,
      };
    case 'always-allowed':
      return {
        text: 'Always allowed',
        glyph: 'double-check',
        tone: 'allowed',
        meaning: `In ${every} the model calls it without waiting for you to allow it.`,
      };
  }
}

export interface ChatToolAnswerRow {
  name: string;
  label: string;
  by: Exclude<DecidedBy, 'default'>;
  tag: { text: string; glyph: TagGlyph; tone: TagTone; meaning: string };
  /** Which list Reset takes it off; null when it is not this chat's or the person's to reset. */
  scope: SetScope | null;
  /** The tag's tip is pinned open. */
  explained: boolean;
  busy: boolean;
  disabled: boolean;
}

/** A tool's name as the catalog words it, else as the thread does. */
function labelOf(lists: ToolLayerLists, name: string): string {
  for (const group of lists.tools) {
    const found = group.tools.find((tool) => tool.name === name);
    if (found) return found.label;
  }
  return toolLabel(name);
}

function isReadTool(lists: ToolLayerLists, name: string): boolean {
  return lists.tools.some((group) =>
    group.tools.some((tool) => tool.name === name && tool.read === true)
  );
}

const ORDER: Exclude<DecidedBy, 'default'>[] = [
  'blocked-here',
  'always-blocked',
  'locked',
  'ask-here',
  'project-ask',
  'allowed-here',
  'project-allow',
  'always-allowed',
];

const SCOPES: Partial<Record<DecidedBy, SetScope>> = {
  'blocked-here': 'chat',
  'ask-here': 'chat',
  'allowed-here': 'chat',
  'always-blocked': 'always',
  'always-allowed': 'always',
};

/**
 * One row per tool something decides, with the decision that applies:
 * blocks first (what someone comes here to undo), then what asks, then
 * what is allowed. A locked tool is listed only when someone also decided
 * something for it (the organization's whole list is on Settings).
 */
export function chatToolAnswerRows(state: ChatToolAnswersState): ChatToolAnswerRow[] {
  const lists = state.answers;
  if (!lists) return [];
  const layers = layersOf(lists);
  const names = new Set([
    ...lists.chat.allow,
    ...lists.chat.deny,
    ...lists.chat.ask,
    ...(lists.project?.allow ?? []),
    ...(lists.project?.ask ?? []),
    ...lists.always.allow,
    ...lists.always.deny,
  ]);
  return [...names]
    .flatMap((name): ChatToolAnswerRow[] => {
      const by = decidedBy(layers, name);
      if (by === 'default') return [];
      return [
        {
          name,
          label: labelOf(lists, name),
          by,
          tag: tagFor(by, lists.kind, lists.project?.name ?? null),
          scope: SCOPES[by] ?? null,
          explained: state.explaining === name,
          busy: state.resetting === name,
          disabled: state.resetting !== null,
        },
      ];
    })
    .sort(
      (a, b) =>
        ORDER.indexOf(a.by) - ORDER.indexOf(b.by) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
}

export interface ChatToolAnswerGroup {
  /** The tool names' shared prefix: `agent` for agent_create. */
  key: string;
  label: string;
  rows: ChatToolAnswerRow[];
}

const PREFIX_LABELS: Record<string, string> = {
  github: 'GitHub',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  onenote: 'OneNote',
  webex: 'Webex',
  admanager: 'AD Manager',
};

/** The rows grouped by the tools' prefix, so two short labels that read alike stay apart. */
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

/** The heading's count: "3 blocked · 1 ask · 2 allowed", leaving out a zero. */
export function chatToolAnswersCount(state: ChatToolAnswersState): string {
  const rows = chatToolAnswerRows(state);
  const count = (tone: TagTone) => rows.filter((row) => row.tag.tone === tone).length;
  return [
    count('blocked') > 0 ? `${count('blocked')} blocked` : null,
    count('asks') > 0 ? `${count('asks')} ask` : null,
    count('allowed') > 0 ? `${count('allowed')} allowed` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Whether the section shows at all: once loaded (it always offers "Set a tool"). */
export function showsChatToolAnswers(state: ChatToolAnswersState): boolean {
  return state.answers !== null;
}

/** The most "Set a tool" lists at once; typing narrows it. */
export const PICKER_LIMIT = 40;

export interface PickerGroup {
  key: string;
  label: string;
  tools: { name: string; label: string; read: boolean; selected: boolean }[];
}

/** What "Set a tool" offers: the chat's tools matching the search, by connector, at most PICKER_LIMIT. */
export function pickerGroups(state: ChatToolAnswersState): { groups: PickerGroup[]; more: number } {
  const lists = state.answers;
  if (!lists) return { groups: [], more: 0 };
  const needle = state.picker.filter.trim().toLowerCase();
  let shown = 0;
  let more = 0;
  const groups: PickerGroup[] = [];
  for (const group of lists.tools) {
    const groupMatches = needle !== '' && group.label.toLowerCase().includes(needle);
    const tools = group.tools.filter(
      (tool) =>
        needle === '' ||
        groupMatches ||
        tool.label.toLowerCase().includes(needle) ||
        tool.name.toLowerCase().includes(needle)
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

export interface SetOption {
  scope: SetScope;
  rule: SetRule;
  label: string;
  glyph: TagGlyph;
  chosen: boolean;
}

/**
 * The choices "Set a tool" offers for the tool picked, in two rows. This
 * chat: Allow (a tool that acts), Ask (a tool that only reads — one that
 * acts asks already), Block. Every chat of this kind: Allow (a tool that
 * acts), Block. Allowing a tool the organization locks is not offered.
 */
export function setOptions(state: ChatToolAnswersState): {
  chat: SetOption[];
  always: SetOption[];
} {
  const lists = state.answers;
  const tool = state.picker.selected;
  if (!lists || !tool) return { chat: [], always: [] };
  const reads = isReadTool(lists, tool);
  const locked = lists.locked.includes(tool);
  const option = (scope: SetScope, rule: SetRule, label: string, glyph: TagGlyph): SetOption => ({
    scope,
    rule,
    label,
    glyph,
    chosen: state.picker.choice?.scope === scope && state.picker.choice.rule === rule,
  });
  return {
    chat: [
      ...(!reads && !locked ? [option('chat', 'allow', 'Allow', 'check')] : []),
      ...(reads ? [option('chat', 'ask', 'Ask', 'question')] : []),
      option('chat', 'deny', 'Block', 'ban'),
    ],
    always: [
      ...(!reads && !locked ? [option('always', 'allow', 'Always allow', 'double-check')] : []),
      option('always', 'deny', 'Always block', 'hand'),
    ],
  };
}

/** The Set dialog's Save: on once a tool and a choice are picked, off while a change is on its way. */
export function blockSave(state: ChatToolAnswersState): { disabled: boolean; label: string } {
  return {
    disabled:
      state.picker.selected === null || state.picker.choice === null || state.resetting !== null,
    label:
      state.resetting !== null && state.resetting === state.picker.selected ? 'Saving…' : 'Save',
  };
}
