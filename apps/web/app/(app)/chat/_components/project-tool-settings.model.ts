/**
 * A project's "Tool permissions", with no React: its own settings for its
 * chats (lib/chat/project-permissions.ts) — Allow (a tool that acts runs
 * without asking in the project's chats) and Ask (a tool waits for a yes
 * first; for a reading tool, the only way it ever asks). One row per
 * tool, with Reset; "Set a tool" picks a tool, Allow or Ask, Save. A tool
 * the organization locks cannot be allowed (it asks anyway). A chat in
 * the project can still block a tool or make it ask for itself, and the
 * person's own blocks still refuse it (lib/chat/tool-decision.ts).
 * Editors change it; anyone the project is shared with reads it.
 * project-tool-settings.tsx renders from this.
 */

import type { ActToolGroup } from '@/lib/chat/permission-rules';
import { toolLabel } from './message-list.model';

export type ProjectRule = 'allow' | 'ask';

export interface ProjectToolLists {
  settings: { allow: string[]; ask: string[] };
  locked: string[];
  tools: ActToolGroup[];
  canEdit: boolean;
}

export interface ProjectToolSettingsState {
  lists: ProjectToolLists | null;
  failedToLoad: boolean;
  busy: string | null;
  error: string | null;
  picker: { open: boolean; filter: string; selected: string | null; rule: ProjectRule | null };
}

export type ProjectToolSettingsAction =
  | { type: 'loaded'; answer: unknown }
  | { type: 'load-failed' }
  | { type: 'change-started'; tool: string }
  | { type: 'change-succeeded'; answer: unknown }
  | { type: 'change-failed'; error: string }
  | { type: 'picker-opened' }
  | { type: 'picker-closed' }
  | { type: 'picker-filter'; filter: string }
  | { type: 'picker-select'; tool: string }
  | { type: 'picker-rule'; rule: ProjectRule };

const CLOSED: ProjectToolSettingsState['picker'] = {
  open: false,
  filter: '',
  selected: null,
  rule: null,
};

export const initialProjectToolSettingsState: ProjectToolSettingsState = {
  lists: null,
  failedToLoad: false,
  busy: null,
  error: null,
  picker: CLOSED,
};

function field(raw: unknown, key: string): unknown {
  return typeof raw === 'object' && raw !== null ? Reflect.get(raw, key) : undefined;
}

function names(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((entry): entry is string => typeof entry === 'string'))].sort()
    : [];
}

function groups(raw: unknown): ActToolGroup[] {
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
          return typeof name === 'string'
            ? [
                {
                  name,
                  label: typeof text === 'string' ? text : name,
                  ...(field(tool, 'read') === true ? { read: true as const } : {}),
                },
              ]
            : [];
        }),
      },
    ];
  });
}

function read(raw: unknown): ProjectToolLists {
  const settings = field(raw, 'settings');
  return {
    settings: { allow: names(field(settings, 'allow')), ask: names(field(settings, 'ask')) },
    locked: names(field(raw, 'locked')),
    tools: groups(field(raw, 'tools')),
    canEdit: field(raw, 'canEdit') === true,
  };
}

export function projectToolSettingsReducer(
  state: ProjectToolSettingsState,
  action: ProjectToolSettingsAction
): ProjectToolSettingsState {
  switch (action.type) {
    case 'loaded':
      return { ...state, lists: read(action.answer), failedToLoad: false };
    case 'load-failed':
      return { ...state, failedToLoad: true };
    case 'change-started':
      return state.busy ? state : { ...state, busy: action.tool, error: null };
    case 'change-succeeded':
      return { ...state, lists: read(action.answer), busy: null, error: null, picker: CLOSED };
    case 'change-failed':
      return { ...state, busy: null, error: action.error };
    case 'picker-opened':
      return { ...state, picker: { ...CLOSED, open: true }, error: null };
    case 'picker-closed':
      return { ...state, picker: CLOSED };
    case 'picker-filter':
      return { ...state, picker: { ...state.picker, filter: action.filter } };
    case 'picker-select':
      return { ...state, picker: { ...state.picker, selected: action.tool, rule: null } };
    case 'picker-rule':
      return { ...state, picker: { ...state.picker, rule: action.rule } };
  }
}

function labelOf(lists: ProjectToolLists, name: string): string {
  for (const group of lists.tools) {
    const found = group.tools.find((tool) => tool.name === name);
    if (found) return found.label;
  }
  return toolLabel(name);
}

export interface ProjectToolRow {
  name: string;
  label: string;
  tag: {
    text: string;
    tone: 'asks' | 'allowed';
    glyph: 'check' | 'question' | 'lock';
    meaning: string;
  };
  busy: boolean;
  disabled: boolean;
}

/** One row per tool the project decides: what asks first, then what is allowed. */
export function projectToolRows(state: ProjectToolSettingsState): ProjectToolRow[] {
  const lists = state.lists;
  if (!lists) return [];
  const row = (name: string, rule: ProjectRule): ProjectToolRow => {
    const locked = rule === 'allow' && lists.locked.includes(name);
    return {
      name,
      label: labelOf(lists, name),
      tag: locked
        ? {
            text: 'Locked · asks',
            tone: 'asks',
            glyph: 'lock',
            meaning:
              'Your organization locks this tool as high risk: it asks every time, whatever the project allows.',
          }
        : rule === 'allow'
          ? {
              text: 'Allowed',
              tone: 'allowed',
              glyph: 'check',
              meaning:
                'Runs without asking in this project’s chats, unless a chat makes it ask or blocks it.',
            }
          : {
              text: 'Asks',
              tone: 'asks',
              glyph: 'question',
              meaning:
                'Waits for a yes before it runs in this project’s chats. A chat can still block it.',
            },
      busy: state.busy === name,
      disabled: state.busy !== null || !lists.canEdit,
    };
  };
  return [
    ...lists.settings.ask.map((name) => row(name, 'ask')),
    ...lists.settings.allow.map((name) => row(name, 'allow')),
  ];
}

/** "Set a tool": the project's tools matching the search, by connector (at most 40). */
export function projectPickerGroups(state: ProjectToolSettingsState): {
  key: string;
  label: string;
  tools: { name: string; label: string; read: boolean; selected: boolean }[];
}[] {
  const lists = state.lists;
  if (!lists) return [];
  const needle = state.picker.filter.trim().toLowerCase();
  let room = 40;
  return lists.tools.flatMap((group) => {
    const hit = needle === '' || group.label.toLowerCase().includes(needle);
    const tools = group.tools
      .filter(
        (tool) =>
          hit ||
          tool.label.toLowerCase().includes(needle) ||
          tool.name.toLowerCase().includes(needle)
      )
      .slice(0, Math.max(0, room));
    room -= tools.length;
    return tools.length > 0
      ? [
          {
            key: group.key,
            label: group.label,
            tools: tools.map((tool) => ({
              name: tool.name,
              label: tool.label,
              read: tool.read === true,
              selected: state.picker.selected === tool.name,
            })),
          },
        ]
      : [];
  });
}

/** The choices for the tool picked: Allow (a tool that acts, not locked) and Ask. */
export function projectRuleOptions(
  state: ProjectToolSettingsState
): { rule: ProjectRule; label: string; chosen: boolean }[] {
  const lists = state.lists;
  const tool = state.picker.selected;
  if (!lists || !tool) return [];
  const reads = lists.tools.some((group) =>
    group.tools.some((entry) => entry.name === tool && entry.read === true)
  );
  const locked = lists.locked.includes(tool);
  return [
    ...(!reads && !locked ? [{ rule: 'allow' as const, label: 'Allow' }] : []),
    { rule: 'ask' as const, label: 'Ask' },
  ].map((option) => ({ ...option, chosen: state.picker.rule === option.rule }));
}

/** Save is on once a tool and a choice are picked, off while a change is on its way. */
export function projectSave(state: ProjectToolSettingsState): { disabled: boolean; label: string } {
  return {
    disabled: !state.picker.selected || !state.picker.rule || state.busy !== null,
    label: state.busy !== null && state.busy === state.picker.selected ? 'Saving…' : 'Save',
  };
}
