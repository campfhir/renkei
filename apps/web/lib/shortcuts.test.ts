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
    expect(formatShortcut('code', 'mac')).toBe('⌘ `');
    expect(formatShortcut('code', 'other')).toBe('Ctrl `');
    expect(formatShortcut('preferences', 'mac')).toBe('⌥ ,');
    expect(formatShortcut('preferences', 'other')).toBe('Alt ,');
    expect(formatShortcut('home', 'mac')).toBe('⌥ H');
    expect(formatShortcut('projects', 'other')).toBe('Alt P');
    expect(formatShortcut('artifacts', 'mac')).toBe('⌥ A');
  });

  it('writes Shift first on a Mac (⇧⌥⌘) and last elsewhere', () => {
    expect(formatShortcut('organization', 'mac')).toBe('⇧ ⌥ ⌘ ,');
    expect(formatShortcut('organization', 'other')).toBe('Ctrl Alt Shift ,');
  });

  it('leaves Shift out of a key that already says it', () => {
    expect(formatShortcut('notifications', 'mac')).toBe('⌥ !');
    expect(formatShortcut('notifications', 'other')).toBe('Alt !');
  });

  it('writes a bare key as itself, the same on every keyboard', () => {
    expect(formatShortcut('new-chat', 'mac')).toBe('C');
    expect(formatShortcut('new-chat', 'other')).toBe('C');
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

  it('tells Preferences from the Organization chord by the keys held with it', () => {
    const option = press('Comma', { altKey: true });
    const all = press('Comma', { metaKey: true, altKey: true, shiftKey: true });
    expect(matchesShortcut('preferences', option, 'mac')).toBe(true);
    expect(matchesShortcut('organization', option, 'mac')).toBe(false);
    expect(matchesShortcut('organization', all, 'mac')).toBe(true);
    expect(matchesShortcut('preferences', all, 'mac')).toBe(false);
    expect(
      matchesShortcut(
        'organization',
        press('Comma', { ctrlKey: true, altKey: true, shiftKey: true }),
        'other'
      )
    ).toBe(true);
  });

  it('reads the Option letters by the physical key, not the character they type', () => {
    expect(matchesShortcut('home', press('KeyH', { altKey: true }), 'mac')).toBe(true);
    expect(matchesShortcut('home', press('KeyH', {}), 'mac')).toBe(false);
    expect(
      matchesShortcut('projects', press('KeyP', { altKey: true, shiftKey: true }), 'mac')
    ).toBe(false);
  });

  it('reads ⌥ ! as Option and Shift on the 1 key, and ⌘ ` on the backquote key', () => {
    expect(
      matchesShortcut('notifications', press('Digit1', { altKey: true, shiftKey: true }), 'mac')
    ).toBe(true);
    expect(matchesShortcut('notifications', press('Digit1', { altKey: true }), 'mac')).toBe(false);
    expect(matchesShortcut('code', press('Backquote', { metaKey: true }), 'mac')).toBe(true);
    expect(matchesShortcut('code', press('Backquote', { ctrlKey: true }), 'mac')).toBe(false);
  });

  it('reads ⌘ ? as Command and Shift on the slash key', () => {
    expect(
      matchesShortcut('tutorials', press('Slash', { ctrlKey: true, shiftKey: true }), 'other')
    ).toBe(true);
    expect(matchesShortcut('tutorials', press('Slash', { ctrlKey: true }), 'other')).toBe(false);
  });
});

describe('stepSequence', () => {
  it('fires `c` at once, since no longer sequence begins with it', () => {
    expect(stepSequence([], 'c')).toEqual({ kind: 'fire', id: 'new-chat' });
  });

  it('ignores keys that lead nowhere', () => {
    expect(stepSequence([], 'x')).toEqual({ kind: 'none' });
    expect(stepSequence(['x'], 'z')).toEqual({ kind: 'none' });
  });

  it('starts over from a key that follows a stray one', () => {
    expect(stepSequence(['x'], 'c')).toEqual({ kind: 'fire', id: 'new-chat' });
  });

  it('ignores case, so Caps Lock does not hide the shortcut', () => {
    expect(stepSequence([], 'C')).toEqual({ kind: 'fire', id: 'new-chat' });
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
