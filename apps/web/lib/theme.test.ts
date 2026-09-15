/**
 * The browser side of the theme preference, exercised against a hand-rolled
 * window/document: Jest runs in the node environment here, and these
 * helpers only touch localStorage, matchMedia, `<html>`'s attribute and
 * window events — nothing worth a DOM implementation.
 */

import {
  applyThemeMode,
  getStoredThemeMode,
  resolveThemeMode,
  setStoredThemeMode,
  subscribeStoredThemeMode,
  themeStorageKey,
} from './theme';

let systemDark = false;
let stored: Map<string, string>;
let attributes: Map<string, string>;
let setAttributeCalls: number;

class FakeWindow extends EventTarget {
  localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  };
  matchMedia = (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' && systemDark,
  });
}

function storageEvent(key: string | null): Event {
  // Node has no StorageEvent; the handler only reads `key`.
  return Object.assign(new Event('storage'), { key });
}

function defineGlobal(name: 'window' | 'document', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  systemDark = false;
  stored = new Map();
  attributes = new Map();
  setAttributeCalls = 0;
  defineGlobal('window', new FakeWindow());
  defineGlobal('document', {
    documentElement: {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => {
        setAttributeCalls += 1;
        attributes.set(name, value);
      },
    },
  });
});

afterEach(() => {
  defineGlobal('window', undefined);
  defineGlobal('document', undefined);
});

describe('resolveThemeMode', () => {
  it("passes an explicit pick through and resolves 'auto' against the system", () => {
    expect(resolveThemeMode('light')).toBe('light');
    expect(resolveThemeMode('dark')).toBe('dark');
    expect(resolveThemeMode('auto')).toBe('light');
    systemDark = true;
    expect(resolveThemeMode('auto')).toBe('dark');
    expect(resolveThemeMode('light')).toBe('light');
  });
});

describe('applyThemeMode', () => {
  it('sets data-theme to the resolved scheme, never to auto', () => {
    systemDark = true;
    applyThemeMode('auto');
    expect(attributes.get('data-theme')).toBe('dark');
    applyThemeMode('light');
    expect(attributes.get('data-theme')).toBe('light');
  });

  it('leaves the attribute alone when it already says so', () => {
    applyThemeMode('dark');
    applyThemeMode('dark');
    applyThemeMode('dark');
    expect(setAttributeCalls).toBe(1);
    systemDark = true;
    applyThemeMode('auto');
    expect(setAttributeCalls).toBe(1);
    systemDark = false;
    applyThemeMode('auto');
    expect(attributes.get('data-theme')).toBe('light');
    expect(setAttributeCalls).toBe(2);
  });
});

describe('the per-browser cache', () => {
  it('is scoped by tenant and ignores anything that is not a mode', () => {
    setStoredThemeMode('t1', 'dark');
    expect(getStoredThemeMode('t1')).toBe('dark');
    expect(getStoredThemeMode('t2')).toBeNull();
    stored.set(themeStorageKey('t2'), 'blue');
    expect(getStoredThemeMode('t2')).toBeNull();
  });

  it('tells a subscriber in this tab about a pick for its tenant only', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeStoredThemeMode('t1', (mode) => seen.push(mode));
    setStoredThemeMode('t1', 'dark');
    setStoredThemeMode('t2', 'light');
    setStoredThemeMode('t1', 'auto');
    expect(seen).toEqual(['dark', 'auto']);

    unsubscribe();
    setStoredThemeMode('t1', 'light');
    expect(seen).toEqual(['dark', 'auto']);
  });

  it("tells a subscriber what another tab wrote, and 'auto' once it is gone", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeStoredThemeMode('t1', (mode) => seen.push(mode));
    // Another tab's write shows up as a storage event, never as our custom one.
    stored.set(themeStorageKey('t1'), 'dark');
    window.dispatchEvent(storageEvent(themeStorageKey('t1')));
    // Some other key in the same origin is not our business.
    window.dispatchEvent(storageEvent('renkei:something-else'));
    // localStorage.clear() elsewhere arrives with a null key.
    stored.clear();
    window.dispatchEvent(storageEvent(null));
    expect(seen).toEqual(['dark', 'auto']);
    unsubscribe();
  });
});
