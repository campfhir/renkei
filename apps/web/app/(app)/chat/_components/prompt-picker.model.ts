/**
 * The prompt picker's behaviour: what the list shows for a search, how it
 * is grouped by library, what a group folds away, and which row Enter
 * takes. Built so a person with hundreds of prompts can still find one by
 * typing, by narrowing to a library, or by arrowing through a short list.
 */

export interface PickerPrompt {
  id: string;
  title: string;
  body: string;
  libraryId: string;
  libraryName: string;
  libraryScope: 'any' | 'code';
}

export interface PickerState {
  /** null until the list has loaded. */
  prompts: PickerPrompt[] | null;
  error: string | null;
  query: string;
  /** Narrowed to one library, or all of them. */
  libraryId: string | null;
  /** Libraries whose folded rows are shown in full. */
  expanded: string[];
  /** Index into the visible rows. */
  active: number;
}

export type PickerAction =
  | { type: 'loaded'; prompts: PickerPrompt[] }
  | { type: 'failed'; error: string }
  | { type: 'queryChanged'; query: string }
  | { type: 'libraryChosen'; libraryId: string | null }
  | { type: 'groupToggled'; libraryId: string }
  | { type: 'moved'; by: 1 | -1 }
  | { type: 'movedTo'; to: 'first' | 'last' }
  | { type: 'pointed'; index: number };

/** A library shows this many prompts before it folds the rest behind "Show all". */
export const GROUP_LIMIT = 6;

/** More libraries than this earns a library filter beside the search box. */
export const LIBRARY_FILTER_FROM = 2;

export function initialPicker(): PickerState {
  return { prompts: null, error: null, query: '', libraryId: null, expanded: [], active: 0 };
}

export interface PickerGroup {
  libraryId: string;
  libraryName: string;
  libraryScope: 'any' | 'code';
  /** Every prompt in the library that matches. */
  total: number;
  rows: PickerPrompt[];
  /** How many matches are folded away. */
  hidden: number;
  expanded: boolean;
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** 0 when every word is in the title, 1 when in the title or body, null for no match. */
function rank(prompt: PickerPrompt, needles: string[]): 0 | 1 | null {
  if (needles.length === 0) return 0;
  const title = prompt.title.toLowerCase();
  const rest = `${title} ${prompt.body.toLowerCase()} ${prompt.libraryName.toLowerCase()}`;
  if (needles.every((needle) => title.includes(needle))) return 0;
  return needles.every((needle) => rest.includes(needle)) ? 1 : null;
}

function matching(state: PickerState): PickerPrompt[] {
  const needles = words(state.query);
  const ranked: { prompt: PickerPrompt; rank: 0 | 1 }[] = [];
  for (const prompt of state.prompts ?? []) {
    if (state.libraryId !== null && prompt.libraryId !== state.libraryId) continue;
    const found = rank(prompt, needles);
    if (found !== null) ranked.push({ prompt, rank: found });
  }
  // Title matches first; the author's order is kept inside each rank.
  return [...ranked.filter((r) => r.rank === 0), ...ranked.filter((r) => r.rank === 1)].map(
    (r) => r.prompt
  );
}

/** Groups by library, libraries by name, each folded to GROUP_LIMIT unless opened or alone. */
export function pickerGroups(state: PickerState): PickerGroup[] {
  const byLibrary = new Map<string, { first: PickerPrompt; list: PickerPrompt[] }>();
  for (const prompt of matching(state)) {
    const entry = byLibrary.get(prompt.libraryId);
    if (entry) entry.list.push(prompt);
    else byLibrary.set(prompt.libraryId, { first: prompt, list: [prompt] });
  }
  const narrowed = state.libraryId !== null;
  return [...byLibrary.entries()]
    .map(([libraryId, { first, list }]) => {
      const expanded = narrowed || state.expanded.includes(libraryId);
      const rows = expanded ? list : list.slice(0, GROUP_LIMIT);
      return {
        libraryId,
        libraryName: first.libraryName,
        libraryScope: first.libraryScope,
        total: list.length,
        rows,
        hidden: list.length - rows.length,
        expanded,
      };
    })
    .sort(
      (a, b) =>
        (a.libraryName < b.libraryName ? -1 : a.libraryName > b.libraryName ? 1 : 0) ||
        (a.libraryId < b.libraryId ? -1 : 1)
    );
}

/** The rows on screen, top to bottom: what the arrow keys walk. */
export function visibleRows(state: PickerState): PickerPrompt[] {
  return pickerGroups(state).flatMap((group) => group.rows);
}

export function activePrompt(state: PickerState): PickerPrompt | null {
  return visibleRows(state)[state.active] ?? null;
}

/** The libraries the filter offers, with how many prompts each holds. */
export function pickerLibraries(state: PickerState): { id: string; name: string; count: number }[] {
  const counts = new Map<string, { id: string; name: string; count: number }>();
  for (const prompt of state.prompts ?? []) {
    const entry = counts.get(prompt.libraryId);
    if (entry) entry.count += 1;
    else counts.set(prompt.libraryId, { id: prompt.libraryId, name: prompt.libraryName, count: 1 });
  }
  return [...counts.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function showLibraryFilter(state: PickerState): boolean {
  return pickerLibraries(state).length >= LIBRARY_FILTER_FROM;
}

/** What the list says when it has no rows. */
export function emptyMessage(state: PickerState): string | null {
  if (state.prompts === null) return null;
  if (visibleRows(state).length > 0) return null;
  if (state.prompts.length === 0) return 'No prompts yet — create a library first.';
  return 'No matches.';
}

function clamp(state: PickerState): PickerState {
  const last = Math.max(0, visibleRows(state).length - 1);
  return state.active > last ? { ...state, active: last } : state;
}

export function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case 'loaded':
      return clamp({ ...state, prompts: action.prompts, error: null });
    case 'failed':
      return { ...state, prompts: state.prompts ?? [], error: action.error };
    case 'queryChanged':
      return { ...state, query: action.query, active: 0 };
    case 'libraryChosen':
      return { ...state, libraryId: action.libraryId, active: 0 };
    case 'groupToggled': {
      const open = state.expanded.includes(action.libraryId);
      return clamp({
        ...state,
        expanded: open
          ? state.expanded.filter((id) => id !== action.libraryId)
          : [...state.expanded, action.libraryId],
      });
    }
    case 'moved': {
      const count = visibleRows(state).length;
      if (count === 0) return state;
      return { ...state, active: Math.min(count - 1, Math.max(0, state.active + action.by)) };
    }
    case 'movedTo': {
      const count = visibleRows(state).length;
      return { ...state, active: action.to === 'first' ? 0 : Math.max(0, count - 1) };
    }
    case 'pointed':
      return { ...state, active: Math.max(0, action.index) };
  }
}
