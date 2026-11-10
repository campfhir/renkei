/**
 * The composer's folded tools button (composer-tools-menu.tsx): closed, or
 * open on its first level (Prompt libraries, Dictate, Voice) or on its
 * second (the voice panel). While dictating, the button is the microphone
 * and a tap stops dictation instead of opening anything. Tested in
 * composer-tools-menu.model.test.ts.
 */

export interface ToolsMenuState {
  open: boolean;
  level: 'tools' | 'voice';
}

export const initialToolsMenu: ToolsMenuState = { open: false, level: 'tools' };

export type ToolsMenuAction =
  /** The button was pressed while not dictating. */
  | { type: 'toggled' }
  /** Closed by an item, Escape, a click outside or the panel's own close. */
  | { type: 'closed' }
  | { type: 'voiceOpened' }
  | { type: 'backToTools' };

export function toolsMenuReducer(state: ToolsMenuState, action: ToolsMenuAction): ToolsMenuState {
  switch (action.type) {
    case 'toggled':
      // Opening always starts at the first level.
      return { open: !state.open, level: 'tools' };
    case 'closed':
      return initialToolsMenu;
    case 'voiceOpened':
      return state.open ? { ...state, level: 'voice' } : state;
    case 'backToTools':
      return { ...state, level: 'tools' };
  }
}

/** What a press on the button does: stop dictating, or open/close the menu. */
export function buttonPress(dictating: boolean): 'stopDictating' | 'toggle' {
  return dictating ? 'stopDictating' : 'toggle';
}

/** The button's name, which is also its tooltip. */
export function buttonLabel(dictating: boolean): string {
  return dictating ? 'Stop dictating' : 'Prompts and voice';
}

export type ToolsMenuItem = 'prompts' | 'dictate' | 'voice';

/** The first level's items, in order: Dictate only with a microphone, Voice only with a speaker menu. */
export function menuItems(context: { canDictate: boolean; hasVoice: boolean }): ToolsMenuItem[] {
  return [
    'prompts',
    ...(context.canDictate ? (['dictate'] as const) : []),
    ...(context.hasVoice ? (['voice'] as const) : []),
  ];
}

/** Which level shows: none, the first, or the voice panel (only when there is one). */
export function shownLevel(state: ToolsMenuState, hasVoice: boolean): 'none' | 'tools' | 'voice' {
  if (!state.open) return 'none';
  if (state.level === 'voice') return hasVoice ? 'voice' : 'none';
  return 'tools';
}
