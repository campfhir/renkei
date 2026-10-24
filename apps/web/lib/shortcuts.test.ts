import {
  detectPlatform,
  expandShortcutTokens,
  formatShortcut,
  matchesShortcut,
  type Platform,
} from './shortcuts';

const press = (
  code: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>>
) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('detectPlatform', () => {
  it('reads a Mac from either the client hints or the legacy platform', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectPlatform({ userAgentData: { platform: 'macOS' }, platform: 'x' })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32' })).toBe('other');
    expect(detectPlatform({ platform: 'Linux x86_64' })).toBe('other');
    expect(detectPlatform(undefined)).toBe('other');
  });
});

describe('formatShortcut', () => {
  it('uses the symbols of the keyboard in front of the person', () => {
    expect(formatShortcut('search', 'mac')).toBe('⌘ K');
    expect(formatShortcut('search', 'other')).toBe('Ctrl K');
    expect(formatShortcut('switch-chat', 'mac')).toBe('⌥ J');
    expect(formatShortcut('switch-chat', 'other')).toBe('Alt J');
  });
});

describe('matchesShortcut', () => {
  it('wants the platform modifier, and only it', () => {
    expect(matchesShortcut('quick-chat', press('KeyJ', { metaKey: true }), 'mac')).toBe(true);
    expect(matchesShortcut('quick-chat', press('KeyJ', { ctrlKey: true }), 'mac')).toBe(false);
    expect(matchesShortcut('quick-chat', press('KeyJ', { ctrlKey: true }), 'other')).toBe(true);
    expect(
      matchesShortcut('quick-chat', press('KeyJ', { ctrlKey: true, shiftKey: true }), 'other')
    ).toBe(false);
  });

  it('tells the two J shortcuts apart', () => {
    const platforms: Platform[] = ['mac', 'other'];
    for (const platform of platforms) {
      expect(matchesShortcut('switch-chat', press('KeyJ', { altKey: true }), platform)).toBe(true);
      expect(matchesShortcut('quick-chat', press('KeyJ', { altKey: true }), platform)).toBe(false);
      expect(matchesShortcut('switch-chat', press('KeyJ', {}), platform)).toBe(false);
    }
  });
});

describe('expandShortcutTokens', () => {
  it('swaps tokens for keys and leaves unknown ones alone', () => {
    expect(expandShortcutTokens('Press {shortcut:quick-chat}.', 'mac')).toBe('Press ⌘ J.');
    expect(expandShortcutTokens('Press {shortcut:nope}.', 'mac')).toBe('Press {shortcut:nope}.');
  });
});
