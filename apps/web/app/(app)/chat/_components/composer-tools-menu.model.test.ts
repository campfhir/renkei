/**
 * The composer's folded tools button on a phone (composer-tools-menu.model.ts).
 * composer-tools-menu.spec.ts keeps that it is the one button at phone width
 * and the separate buttons at desktop width, that the row fits, Escape, and
 * one walk through the real menu.
 */

import {
  buttonLabel,
  buttonPress,
  initialToolsMenu,
  menuItems,
  shownLevel,
  toolsMenuReducer,
  type ToolsMenuAction,
} from './composer-tools-menu.model';

const run = (actions: ToolsMenuAction[]) => actions.reduce(toolsMenuReducer, initialToolsMenu);

describe('the tools button', () => {
  it('opens on the first level and closes on a second press', () => {
    expect(shownLevel(run([{ type: 'toggled' }]), true)).toBe('tools');
    expect(shownLevel(run([{ type: 'toggled' }, { type: 'toggled' }]), true)).toBe('none');
  });

  it('Voice opens the voice panel as the second level, with a way back', () => {
    const voice = run([{ type: 'toggled' }, { type: 'voiceOpened' }]);
    expect(shownLevel(voice, true)).toBe('voice');
    expect(shownLevel(toolsMenuReducer(voice, { type: 'backToTools' }), true)).toBe('tools');
  });

  it('closing from the voice level and opening again starts on the first level', () => {
    const reopened = run([
      { type: 'toggled' },
      { type: 'voiceOpened' },
      { type: 'closed' },
      { type: 'toggled' },
    ]);
    expect(shownLevel(reopened, true)).toBe('tools');
  });

  it('Prompt libraries and Dictate act at once and close the menu', () => {
    expect(shownLevel(run([{ type: 'toggled' }, { type: 'closed' }]), true)).toBe('none');
  });

  it('while dictating the button is the microphone: a tap stops it, nothing opens', () => {
    expect(buttonPress(true)).toBe('stopDictating');
    expect(buttonLabel(true)).toBe('Stop dictating');
    expect(buttonPress(false)).toBe('toggle');
    expect(buttonLabel(false)).toBe('Prompts and voice');
  });

  it('lists Dictate only with a microphone and Voice only with a speaker menu', () => {
    expect(menuItems({ canDictate: true, hasVoice: true })).toEqual([
      'prompts',
      'dictate',
      'voice',
    ]);
    expect(menuItems({ canDictate: false, hasVoice: true })).toEqual(['prompts', 'voice']);
    expect(menuItems({ canDictate: true, hasVoice: false })).toEqual(['prompts', 'dictate']);
  });

  it('shows no voice level when there is no voice panel to show', () => {
    expect(shownLevel(run([{ type: 'toggled' }, { type: 'voiceOpened' }]), false)).toBe('none');
  });
});
