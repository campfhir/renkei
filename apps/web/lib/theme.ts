/**
 * The browser side of the theme preference: where it's cached in THIS
 * browser, how 'auto' resolves to an actual light/dark, and how the shell
 * hears about a change made somewhere other than the server.
 *
 * `<html data-theme>` is what everything actually renders against — see the
 * `@custom-variant dark` and the `[data-theme='dark']` blocks in
 * globals.css. This module never leaves it as 'auto': that would ask every
 * one of those rules to re-implement system-preference resolution, so it's
 * done once, here, and the DOM only ever sees a concrete 'light' or 'dark'.
 */

import type { ThemeMode } from '@renkei/user-prefs/prefs';

export function themeStorageKey(): string {
  return `renkei:theme`;
}

/**
 * Told by setStoredThemeMode, so the shell's ThemeSync in THIS tab hears a
 * pick made in the Appearance form. The browser's own `storage` event only
 * ever reaches OTHER tabs of the same origin, never the one that wrote — so
 * without this, the tab where somebody picked Dark would keep following
 * the system until they reloaded it. Module state rather than a DOM event:
 * the form and the shell share this one module instance.
 */
const localListeners = new Set<(mode: ThemeMode) => void>();

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/** Whatever this browser last knew — or null if nothing valid is cached. */
export function getStoredThemeMode(): ThemeMode | null {
  try {
    const stored = window.localStorage.getItem(themeStorageKey());
    return isThemeMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function setStoredThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(themeStorageKey(), mode);
  } catch {
    // The preference just won't stick in this browser.
  }
  // Told separately from the write: a browser that refuses localStorage
  // should still render the pick for the rest of this visit.
  for (const listener of localListeners) listener(mode);
}

/**
 * Calls `onChange` whenever the cached mode moves: a pick in this
 * tab (setStoredThemeMode above) or a pick or save in another tab of the
 * same browser (the `storage` event). Returns the unsubscribe.
 */
export function subscribeStoredThemeMode(
  onChange: (mode: ThemeMode) => void
): () => void {
  const key = themeStorageKey();
  const onLocal = (mode: ThemeMode) => onChange(mode);
  const onStorage = (event: StorageEvent) => {
    // A null key is `localStorage.clear()`, which took this key with it.
    if (event.key !== null && event.key !== key) return;
    onChange(getStoredThemeMode() ?? 'auto');
  };
  localListeners.add(onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    localListeners.delete(onLocal);
    window.removeEventListener('storage', onStorage);
  };
}

/** 'auto' resolved against the system's current answer; 'light'/'dark' pass through. */
export function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'auto') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Sets `data-theme` on <html> to what `mode` resolves to right now.
 *
 * Skipped when the attribute already says so: a same-value setAttribute is
 * still a mutation to the browser (a style recalculation, and every
 * MutationObserver watching the attribute — the code editor has one), and
 * ThemeSync calls this on every wake-up of an 'auto' tab.
 */
export function applyThemeMode(mode: ThemeMode): void {
  const resolved = resolveThemeMode(mode);
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== resolved) root.setAttribute('data-theme', resolved);
}
