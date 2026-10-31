/**
 * The chips combo box's state (ui.ts's chipsField), with no DOM: which
 * values are chosen, in the order they were chosen, and what the search
 * list still offers. The field renders from this and sends `chosen`; the
 * rules — a typed label or value adds its option, never a half-typed
 * word, never twice; × or Backspace takes one off and it is offered again
 * — are tested here (chips.test.ts) instead of through a browser.
 */

export interface ChipOption {
  value: string;
  label: string;
}

export interface ChipsState {
  readonly options: readonly ChipOption[];
  /** Chosen option values, oldest first. */
  readonly chosen: readonly string[];
}

export type ChipsAction =
  /** The search box's text, on a pick from the list, Enter, or a change. */
  | { type: 'typed'; text: string }
  /** A chip's × pressed. */
  | { type: 'remove'; value: string }
  /** Backspace in an empty search box: the newest chip comes off. */
  | { type: 'backspace' };

/** The starting state: the values the model passed, once each, in order. */
export function initialChips(
  options: readonly ChipOption[],
  values: readonly string[]
): ChipsState {
  return { options, chosen: [...new Set(values)] };
}

/**
 * The option a search box's text names exactly (its label or its value,
 * ignoring case and the spaces around it), or none for a partial word.
 */
export function matchOption(options: readonly ChipOption[], text: string): ChipOption | undefined {
  const typed = text.trim().toLowerCase();
  if (!typed) return undefined;
  return options.find(
    (option) => option.label.toLowerCase() === typed || option.value.toLowerCase() === typed
  );
}

export function chipsReducer(state: ChipsState, action: ChipsAction): ChipsState {
  switch (action.type) {
    case 'typed': {
      const match = matchOption(state.options, action.text);
      if (!match || state.chosen.includes(match.value)) return state;
      return { ...state, chosen: [...state.chosen, match.value] };
    }
    case 'remove':
      if (!state.chosen.includes(action.value)) return state;
      return { ...state, chosen: state.chosen.filter((value) => value !== action.value) };
    case 'backspace':
      if (state.chosen.length === 0) return state;
      return { ...state, chosen: state.chosen.slice(0, -1) };
  }
}

/** The label a chip shows for a value: its option's, or the value itself. */
export function chipLabel(state: ChipsState, value: string): string {
  return state.options.find((option) => option.value === value)?.label ?? value;
}

/** What the search list offers: every option not yet chosen, in option order. */
export function offeredOptions(state: ChipsState): ChipOption[] {
  return state.options.filter((option) => !state.chosen.includes(option.value));
}
