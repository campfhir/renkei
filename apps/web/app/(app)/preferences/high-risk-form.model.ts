/**
 * A high-risk list, with no React: one form for three lists.
 *
 *  - 'agents' and 'code' are a person's own (Preferences › Agents and
 *    Preferences › Code projects; @renkei/user-prefs' high-risk.ts). The
 *    organization's locked tools show switched on and cannot be switched
 *    off; every other tool starts at its kind's default and the person's
 *    answer is kept as a departure from it.
 *  - 'org' is the organization's locked list itself (admin Settings): an
 *    operator switches tools on and off, and nothing is locked to them.
 *
 * Folds per connector, a filter over tool and connector names, "all of
 * this connector" both ways, "use the default" (the person's lists back to
 * their kind's default; for the org, nothing it has not saved), and Save,
 * which is on only when something changed. A save's answer replaces what
 * is on screen. high-risk-form.tsx renders from this; tested beside it.
 */

import {
  DEFAULT_HIGH_RISK_PREFS,
  highRiskTest,
  parseHighRiskPrefs,
  withHighRisk,
  type HighRiskKind,
  type HighRiskPrefs,
} from '@renkei/user-prefs/prefs';
import type { ActToolGroup } from '@/lib/chat/permission-rules';

export type HighRiskListKind = HighRiskKind | 'org';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface HighRiskFormState {
  kind: HighRiskListKind;
  /** The org's locked tools: fixed for a person's list, what is edited for 'org'. */
  locked: string[];
  savedLocked: string[];
  /** A person's departures from the default (unused for 'org'). */
  prefs: HighRiskPrefs;
  saved: HighRiskPrefs;
  filter: string;
  status: SaveStatus;
}

export type HighRiskFormAction =
  | { type: 'set'; name: string; on: boolean }
  | { type: 'set-all'; group: ActToolGroup; on: boolean }
  | { type: 'filter'; text: string }
  | { type: 'use-default' }
  | { type: 'save-started' }
  /** The server stored it; `stored` is its answer (a person's lists, or the org's `{ tools }`). */
  | { type: 'save-succeeded'; stored: unknown }
  | { type: 'save-failed' };

export function initHighRiskForm(input: {
  kind: HighRiskListKind;
  locked: string[];
  prefs?: HighRiskPrefs;
}): HighRiskFormState {
  const locked = [...new Set(input.locked)].sort();
  const prefs = input.prefs ?? DEFAULT_HIGH_RISK_PREFS;
  return {
    kind: input.kind,
    locked,
    savedLocked: locked,
    prefs,
    saved: prefs,
    filter: '',
    status: 'idle',
  };
}

/** Whether the switch for this tool is on. */
export function isOn(state: HighRiskFormState, name: string): boolean {
  if (state.kind === 'org') return state.locked.includes(name);
  return highRiskTest(state.prefs, state.kind, state.locked)(name);
}

/** Whether the switch is held on by the organization (never, on the org's own list). */
export function isLocked(state: HighRiskFormState, name: string): boolean {
  return state.kind !== 'org' && state.locked.includes(name);
}

function setOne(state: HighRiskFormState, name: string, on: boolean): HighRiskFormState {
  if (state.kind === 'org') {
    const locked = state.locked.filter((entry) => entry !== name);
    if (on) locked.push(name);
    return { ...state, locked: locked.sort() };
  }
  if (isLocked(state, name)) return state;
  return { ...state, prefs: withHighRisk(state.prefs, state.kind, name, on) };
}

export function highRiskFormReducer(
  state: HighRiskFormState,
  action: HighRiskFormAction
): HighRiskFormState {
  switch (action.type) {
    case 'set':
      return { ...setOne(state, action.name, action.on), status: 'idle' };
    case 'set-all': {
      let next = state;
      for (const tool of action.group.tools) next = setOne(next, tool.name, action.on);
      return { ...next, status: 'idle' };
    }
    case 'filter':
      return { ...state, filter: action.text };
    case 'use-default':
      return state.kind === 'org'
        ? { ...state, locked: state.savedLocked, status: 'idle' }
        : { ...state, prefs: DEFAULT_HIGH_RISK_PREFS, status: 'idle' };
    case 'save-started':
      return { ...state, status: 'saving' };
    case 'save-succeeded': {
      if (state.kind === 'org') {
        const tools: unknown =
          typeof action.stored === 'object' && action.stored !== null
            ? Reflect.get(action.stored, 'tools')
            : null;
        const locked = Array.isArray(tools)
          ? tools.filter((tool): tool is string => typeof tool === 'string').sort()
          : state.locked;
        return { ...state, locked, savedLocked: locked, status: 'saved' };
      }
      const stored = parseHighRiskPrefs(action.stored);
      return { ...state, prefs: stored, saved: stored, status: 'saved' };
    }
    case 'save-failed':
      return { ...state, status: 'failed' };
  }
}

const same = (a: string[], b: string[]) => a.join('\n') === b.join('\n');

export function isDirty(state: HighRiskFormState): boolean {
  if (state.kind === 'org') return !same(state.locked, state.savedLocked);
  return (
    !same(state.prefs.marked, state.saved.marked) ||
    !same(state.prefs.unmarked, state.saved.unmarked)
  );
}

export function canSave(state: HighRiskFormState): boolean {
  return state.status !== 'saving' && isDirty(state);
}

/** What Save sends: the org's whole list, or the person's two lists. */
export function saveBody(
  state: HighRiskFormState
): { tools: string[] } | { kind: HighRiskKind; marked: string[]; unmarked: string[] } {
  if (state.kind === 'org') return { tools: state.locked };
  return { kind: state.kind, marked: state.prefs.marked, unmarked: state.prefs.unmarked };
}

/** "Use the default" does something: the person has departures, or the org edited its list. */
export function canUseDefault(state: HighRiskFormState): boolean {
  if (state.kind === 'org') return isDirty(state);
  return state.prefs.marked.length > 0 || state.prefs.unmarked.length > 0;
}

/** The groups and tools the filter leaves, empty groups dropped. */
export function visibleGroups(state: HighRiskFormState, groups: ActToolGroup[]): ActToolGroup[] {
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) =>
      group.label.toLowerCase().includes(needle)
        ? group
        : {
            ...group,
            tools: group.tools.filter(
              (tool) =>
                tool.label.toLowerCase().includes(needle) ||
                tool.name.toLowerCase().includes(needle)
            ),
          }
    )
    .filter((group) => group.tools.length > 0);
}

/** How many of a group's tools are on, as its shut fold says it. */
export function groupSummary(state: HighRiskFormState, group: ActToolGroup): string {
  const on = group.tools.filter((tool) => isOn(state, tool.name)).length;
  const word = state.kind === 'org' ? 'locked' : 'high risk';
  return on === 0 ? `none of ${group.tools.length}` : `${on} ${word} of ${group.tools.length}`;
}

/** How many listed tools are on, for the line above the folds. */
export function totalOn(state: HighRiskFormState, groups: ActToolGroup[]): number {
  return new Set(
    groups.flatMap((group) =>
      group.tools.filter((tool) => isOn(state, tool.name)).map((t) => t.name)
    )
  ).size;
}

/**
 * Names on the list that no listed tool carries — a connector this person
 * cannot reach, a tool since renamed — kept and said, rather than dropped
 * silently on the next Save. For 'org' every locked name; for a person,
 * the org's locked names and their own marks.
 */
export function unlistedNames(state: HighRiskFormState, groups: ActToolGroup[]): string[] {
  const listed = new Set(groups.flatMap((group) => group.tools.map((tool) => tool.name)));
  const names = state.kind === 'org' ? state.locked : [...state.locked, ...state.prefs.marked];
  return [...new Set(names)].filter((name) => !listed.has(name)).sort();
}
