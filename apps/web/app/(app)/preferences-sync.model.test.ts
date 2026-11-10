/**
 * What a preference change made outside its own form re-renders
 * (preferences-sync.model.ts).
 */

import {
  defaultToolsReload,
  documentsChangedIn,
  shellRefreshes,
  themeChanged,
  voiceReloads,
} from './preferences-sync.model';

describe('a change to the theme', () => {
  it('re-renders the shell, which carries dark mode and the line-number gutter', () => {
    expect(shellRefreshes(['theme'])).toBe(true);
    expect(themeChanged(['theme'])).toBe(true);
  });

  it('leaves the voice menu and the tools dialog alone', () => {
    expect(voiceReloads(['theme'])).toBe(false);
    expect(defaultToolsReload(['theme'])).toBe(false);
  });
});

describe('a change to voice', () => {
  it('is re-read by the thread, and costs the shell nothing', () => {
    expect(voiceReloads(['voice'])).toBe(true);
    expect(shellRefreshes(['voice'])).toBe(false);
    expect(themeChanged(['voice'])).toBe(false);
  });
});

describe('a change to the default tools', () => {
  it('makes the tools dialog forget its catalog and the Preferences page show the new defaults', () => {
    expect(defaultToolsReload(['defaultTools'])).toBe(true);
    expect(shellRefreshes(['defaultTools'])).toBe(true);
  });
});

describe('several documents at once', () => {
  it('re-renders everything any of them decides', () => {
    const documents = ['voice', 'theme', 'defaultTools'];
    expect(shellRefreshes(documents)).toBe(true);
    expect(voiceReloads(documents)).toBe(true);
    expect(defaultToolsReload(documents)).toBe(true);
  });

  it('a document nobody renders from re-renders nothing', () => {
    expect(shellRefreshes(['somethingNew'])).toBe(false);
    expect(voiceReloads(['somethingNew'])).toBe(false);
    expect(defaultToolsReload(['somethingNew'])).toBe(false);
  });
});

describe('what a finished turn changed', () => {
  const call = (input: unknown) => ({
    type: 'tool_use',
    name: 'renkei_set_preferences',
    input,
  });

  it('is nothing for a turn that never called the preference tool', () => {
    const messages = [
      { turnId: 't1', blocks: [{ type: 'text' }, { type: 'tool_use', name: 'renkei_link' }] },
    ];
    expect(documentsChangedIn(messages, 't1')).toEqual([]);
  });

  it('is the documents its calls named', () => {
    const messages = [
      { turnId: 't1', blocks: [call({ theme: { mode: 'dark' } })] },
      { turnId: 't1', blocks: [call({ voice: { rate: 1.5 }, theme: { codeLineNumbers: true } })] },
    ];
    expect(documentsChangedIn(messages, 't1').sort()).toEqual(['theme', 'voice']);
  });

  it("leaves out another turn's calls: that change was announced when it happened", () => {
    const messages = [
      { turnId: 't0', blocks: [call({ theme: { mode: 'dark' } })] },
      { turnId: 't1', blocks: [{ type: 'text' }] },
    ];
    expect(documentsChangedIn(messages, 't1')).toEqual([]);
  });

  it('takes a call whose input cannot be read to have touched everything', () => {
    const changed = documentsChangedIn([{ turnId: 't1', blocks: [call(undefined)] }], 't1');
    expect(changed).toEqual(expect.arrayContaining(['theme', 'voice', 'defaultTools']));
  });
});
