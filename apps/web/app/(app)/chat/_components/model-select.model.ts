/**
 * What the composer's model picker decides: which models a search keeps,
 * which one the arrow keys and Enter act on, when a pick closes the menu,
 * and where the menu sits so it stays on screen with its list scrolling
 * inside it. The component (model-select.tsx) measures, focuses and draws.
 */

import type { ModelOption } from '@/lib/chat/views';

type Searchable = Pick<ModelOption, 'id' | 'label' | 'provider' | 'model'>;

/** A roster this long gets a search box; a shorter one is read at a glance. */
export const SEARCH_FROM = 6;

export function showsSearch(models: readonly unknown[]): boolean {
  return models.length >= SEARCH_FROM;
}

/**
 * The models a search keeps, in roster order: every word typed must appear
 * somewhere in the label, the provider or the model id, in any case.
 */
export function matchingModels<M extends Searchable>(models: readonly M[], query: string): M[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  return models.filter((model) => {
    const text = `${model.label} ${model.provider} ${model.model}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export interface ModelSelectState {
  open: boolean;
  query: string;
  /** The row the keyboard is on; null until a search or an arrow key puts it somewhere. */
  activeId: string | null;
}

export const closedModelSelect: ModelSelectState = { open: false, query: '', activeId: null };

export type ModelSelectAction =
  | { type: 'toggled' }
  | { type: 'dismissed' }
  | { type: 'searched'; query: string; models: readonly Searchable[] }
  /** An arrow key: one row down (1) or up (-1) among the rows the search kept. */
  | { type: 'moved'; by: 1 | -1; models: readonly Searchable[] }
  | { type: 'picked'; supportsThinking: boolean };

export function modelSelectReducer(
  state: ModelSelectState,
  action: ModelSelectAction
): ModelSelectState {
  switch (action.type) {
    case 'toggled':
      // Every opening starts from the whole roster.
      return state.open ? closedModelSelect : { ...closedModelSelect, open: true };
    case 'dismissed':
      return closedModelSelect;
    case 'searched': {
      const first = action.query.trim() ? matchingModels(action.models, action.query)[0] : null;
      return { ...state, query: action.query, activeId: first?.id ?? null };
    }
    case 'moved': {
      const rows = matchingModels(action.models, state.query);
      if (rows.length === 0) return { ...state, activeId: null };
      const at = rows.findIndex((row) => row.id === state.activeId);
      const next = at === -1 ? (action.by === 1 ? 0 : rows.length - 1) : at + action.by;
      const row = rows[Math.min(rows.length - 1, Math.max(0, next))];
      return { ...state, activeId: row?.id ?? null };
    }
    case 'picked':
      // A model that takes a thinking budget keeps the menu open: its
      // switch is right there to be set next.
      return action.supportsThinking ? state : closedModelSelect;
  }
}

/** The model Enter picks from the search box, if the keyboard is on one. */
export function enterPicks<M extends Searchable>(
  state: ModelSelectState,
  models: readonly M[]
): M | null {
  return matchingModels(models, state.query).find((row) => row.id === state.activeId) ?? null;
}

/** The menu's widest and tallest, and the gap it keeps from the edges, in px. */
export const MENU_WIDTH = 288;
export const MENU_MAX_HEIGHT = 448;
export const MENU_MIN_HEIGHT = 176;
export const MENU_MARGIN = 8;

export interface MenuPlacement {
  width: number;
  /** How far the menu's left edge sits from its button's (negative: pulled left). */
  left: number;
  /** The whole menu's height limit; the list scrolls inside it. */
  maxHeight: number;
}

/**
 * Where the menu, which opens upward from its button's left edge, fits:
 * no wider than the screen, pulled left when it would run off the right
 * edge, and no taller than the room between the button and the top of
 * the page's content.
 */
export function placeMenu(input: {
  buttonLeft: number;
  buttonTop: number;
  viewportWidth: number;
  /** Where the page's content starts, under the app's top bar. */
  contentTop: number;
}): MenuPlacement {
  const width = Math.max(0, Math.min(MENU_WIDTH, input.viewportWidth - 2 * MENU_MARGIN));
  const overflow = input.buttonLeft + width + MENU_MARGIN - input.viewportWidth;
  const left = Math.max(MENU_MARGIN - input.buttonLeft, Math.min(0, -overflow));
  const room = input.buttonTop - Math.max(0, input.contentTop) - 2 * MENU_MARGIN;
  const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, room));
  return { width, left, maxHeight };
}
