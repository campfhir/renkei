import {
  CHORDS,
  SEQUENCES,
  detectPlatform,
  expandShortcutTokens,
  formatShortcut,
  isChordId,
  isTypingTarget,
  matchesShortcut,
  stepSequence,
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
    expect(formatShortcut('switch-chat', 'mac')).toBe('⌘ J');
    expect(formatShortcut('switch-chat', 'other')).toBe('Ctrl J');
    expect(formatShortcut('tutorials', 'mac')).toBe('⌘ ?');
    expect(formatShortcut('preferences', 'other')).toBe('Ctrl ,');
  });

  it('writes Shift before Command on a Mac and after Ctrl elsewhere', () => {
    expect(formatShortcut('organization', 'mac')).toBe('⇧ ⌘ ,');
    expect(formatShortcut('organization', 'other')).toBe('Ctrl Shift ,');
  });

  it('writes a sequence as keys typed in turn, the same on every keyboard', () => {
    expect(formatShortcut('new-chat', 'mac')).toBe('C');
    expect(formatShortcut('agents', 'other')).toBe('A then G');
    expect(formatShortcut('code', 'mac')).toBe('\\ then C');
  });
});

describe('matchesShortcut', () => {
  it('wants the platform modifier, and only it', () => {
    expect(matchesShortcut('switch-chat', press('KeyJ', { metaKey: true }), 'mac')).toBe(true);
    expect(matchesShortcut('switch-chat', press('KeyJ', { ctrlKey: true }), 'mac')).toBe(false);
    expect(matchesShortcut('switch-chat', press('KeyJ', { ctrlKey: true }), 'other')).toBe(true);
    expect(matchesShortcut('switch-chat', press('KeyJ', { altKey: true }), 'other')).toBe(false);
  });

  it('lets the switcher take Shift but no other chord', () => {
    const shifted = press('KeyJ', { ctrlKey: true, shiftKey: true });
    expect(matchesShortcut('switch-chat', shifted, 'other')).toBe(false);
    expect(matchesShortcut('switch-chat', shifted, 'other', true)).toBe(true);
  });

  it('tells Preferences from the Organization chord by Shift', () => {
    const comma = press('Comma', { metaKey: true });
    const shiftComma = press('Comma', { metaKey: true, shiftKey: true });
    expect(matchesShortcut('preferences', comma, 'mac')).toBe(true);
    expect(matchesShortcut('organization', comma, 'mac')).toBe(false);
    expect(matchesShortcut('organization', shiftComma, 'mac')).toBe(true);
    expect(matchesShortcut('preferences', shiftComma, 'mac')).toBe(false);
  });

  it('reads ⌘ ? as Command and Shift on the slash key', () => {
    expect(
      matchesShortcut('tutorials', press('Slash', { ctrlKey: true, shiftKey: true }), 'other')
    ).toBe(true);
    expect(matchesShortcut('tutorials', press('Slash', { ctrlKey: true }), 'other')).toBe(false);
  });
});

describe('stepSequence', () => {
  it('fires a sequence nothing longer begins at once', () => {
    expect(stepSequence([], 'n')).toEqual({ kind: 'pending', buffer: ['n'], fire: null });
    expect(stepSequence(['n'], 'o')).toEqual({ kind: 'fire', id: 'notifications' });
    expect(stepSequence([], '\\')).toEqual({ kind: 'pending', buffer: ['\\'], fire: null });
    expect(stepSequence(['\\'], 'c')).toEqual({ kind: 'fire', id: 'code' });
  });

  it('holds `c` for `c h`, and settles on new chat if no h comes', () => {
    expect(stepSequence([], 'c')).toEqual({ kind: 'pending', buffer: ['c'], fire: 'new-chat' });
    expect(stepSequence(['c'], 'h')).toEqual({ kind: 'fire', id: 'chat-history' });
  });

  it('starts over from a key that leads nowhere', () => {
    expect(stepSequence(['a'], 'c')).toEqual({ kind: 'pending', buffer: ['c'], fire: 'new-chat' });
    expect(stepSequence(['a'], 'x')).toEqual({ kind: 'none' });
    expect(stepSequence([], 'z')).toEqual({ kind: 'none' });
  });

  it('ignores case, so Caps Lock does not hide the shortcuts', () => {
    expect(stepSequence(['a'], 'G')).toEqual({ kind: 'fire', id: 'agents' });
  });

  it('keeps every sequence reachable: no two share keys, and each fires when typed', () => {
    const seen = new Set<string>();
    for (const [id, def] of Object.entries(SEQUENCES)) {
      const joined = def.keys.join('');
      expect(seen.has(joined)).toBe(false);
      seen.add(joined);
      let buffer: string[] = [];
      let last = stepSequence(buffer, def.keys[0]);
      for (const key of def.keys.slice(1)) {
        buffer = last.kind === 'pending' ? last.buffer : [];
        last = stepSequence(buffer, key);
      }
      const settled = last.kind === 'pending' ? last.fire : last.kind === 'fire' ? last.id : null;
      expect(settled).toBe(id);
    }
  });
});

describe('isTypingTarget', () => {
  it('stands down in fields, editors and anything that says it is a textbox', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', getAttribute: () => 'textbox' })).toBe(true);
  });

  it('lets bare keys through on the page itself', () => {
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON', getAttribute: () => null })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('expandShortcutTokens', () => {
  it('swaps tokens for keys and leaves unknown ones alone', () => {
    expect(expandShortcutTokens('Press {shortcut:switch-chat}.', 'mac')).toBe('Press ⌘ J.');
    expect(expandShortcutTokens('Press {shortcut:new-chat}.', 'mac')).toBe('Press C.');
    expect(expandShortcutTokens('Press {shortcut:nope}.', 'mac')).toBe('Press {shortcut:nope}.');
  });
});

it('gives every chord a distinct key and modifier set', () => {
  const platforms: Platform[] = ['mac', 'other'];
  for (const platform of platforms) {
    const labels = Object.keys(CHORDS)
      .filter(isChordId)
      .map((id) => formatShortcut(id, platform));
    expect(new Set(labels).size).toBe(labels.length);
  }
});
