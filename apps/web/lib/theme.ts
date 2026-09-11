/**
 * The browser side of the theme preference: where it's cached in THIS
 * browser, and how 'auto' resolves to an actual light/dark.
 *
 * Scoped by tenant, matching every other per-browser cache in this app (see
 * desktop-notifications-storage.ts): one person can sign into more than one
 * tenant from the same browser, and `@renkei/user-prefs` already keys the
 * server-side row the same way.
 *
 * `<html data-theme>` is what everything actually renders against — see the
 * `@custom-variant dark` and the `[data-theme='dark']` blocks in
 * globals.css. This module never leaves it as 'auto': that would ask every
 * one of those rules to re-implement system-preference resolution, so it's
 * done once, here, and the DOM only ever sees a concrete 'light' or 'dark'.
 */

import type { ThemeMode } from '@renkei/user-prefs/prefs';

export function themeStorageKey(tenantId: string): string {
  return `renkei:theme:${tenantId}`;
}

/** Whatever this browser last knew, for this tenant — or null if nothing valid is cached. */
export function getStoredThemeMode(tenantId: string): ThemeMode | null {
  try {
    const stored = window.localStorage.getItem(themeStorageKey(tenantId));
    return stored === 'auto' || stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

export function setStoredThemeMode(tenantId: string, mode: ThemeMode): void {
  try {
    window.localStorage.setItem(themeStorageKey(tenantId), mode);
  } catch {
    // The preference just won't stick in this browser.
  }
}

/** 'auto' resolved against the system's current answer; 'light'/'dark' pass through. */
export function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'auto') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Sets `data-theme` on <html> to what `mode` resolves to right now. */
export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', resolveThemeMode(mode));
}
