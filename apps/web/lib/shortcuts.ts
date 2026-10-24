/**
 * The app's global keyboard shortcuts, and how each is written for the
 * keyboard in front of the person: ⌘ K on a Mac, Ctrl K elsewhere. Pure, so
 * the labels, the matching and the coach-mark copy can be unit-tested.
 *
 * Matching goes by the physical key (`event.code`), not the character: on a
 * Mac, Option turns J into "∆", so `event.key` would never read "j".
 *
 * Browsers keep Ctrl/⌘+N, +T, +W and Ctrl+Tab for themselves — a page cannot
 * intercept them — so these use keys a page may claim.
 */

export type Platform = 'mac' | 'other';

export type ShortcutId = 'search' | 'quick-chat' | 'switch-chat';

interface ShortcutDef {
  /** `event.code` of the key. */
  code: string;
  /** The label of the key itself. */
  key: string;
  /** Command (⌘) on a Mac, Control elsewhere. */
  mod?: boolean;
  /** Option (⌥) on a Mac, Alt elsewhere. */
  alt?: boolean;
}

export const SHORTCUTS: Record<ShortcutId, ShortcutDef> = {
  search: { code: 'KeyK', key: 'K', mod: true },
  'quick-chat': { code: 'KeyJ', key: 'J', mod: true },
  'switch-chat': { code: 'KeyJ', key: 'J', alt: true },
};

function isShortcutId(id: string): id is ShortcutId {
  return Object.hasOwn(SHORTCUTS, id);
}

/** The keyboard's platform from the browser's own words; a server render says 'other'. */
export function detectPlatform(
  nav: { platform?: string; userAgentData?: { platform?: string } } | undefined
): Platform {
  const name = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad|ipod/i.test(name) ? 'mac' : 'other';
}

/** The keys of a shortcut as separate labels, for drawing each as a key cap. */
export function shortcutKeys(id: ShortcutId, platform: Platform): string[] {
  const def = SHORTCUTS[id];
  const keys: string[] = [];
  if (def.mod) keys.push(platform === 'mac' ? '⌘' : 'Ctrl');
  if (def.alt) keys.push(platform === 'mac' ? '⌥' : 'Alt');
  keys.push(def.key);
  return keys;
}

/** "⌘ K" or "Ctrl K" — the keys as one line of text. */
export function formatShortcut(id: ShortcutId, platform: Platform): string {
  return shortcutKeys(id, platform).join(' ');
}

/** Whether a keydown is this shortcut — exactly its modifiers, no others. */
export function matchesShortcut(
  id: ShortcutId,
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  platform: Platform,
  /** Accept Shift too — a switcher walks backwards with it. */
  anyShift = false
): boolean {
  const def = SHORTCUTS[id];
  if (event.code !== def.code) return false;
  const modDown = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const modOther = platform === 'mac' ? event.ctrlKey : event.metaKey;
  return (
    modDown === Boolean(def.mod) &&
    !modOther &&
    event.altKey === Boolean(def.alt) &&
    (anyShift || !event.shiftKey)
  );
}

/**
 * Coach-mark copy names a shortcut as `{shortcut:quick-chat}`; the tour card
 * swaps in the keys for this person's keyboard.
 */
export function expandShortcutTokens(text: string, platform: Platform): string {
  return text.replace(/\{shortcut:([a-z-]+)\}/g, (whole, id: string) =>
    isShortcutId(id) ? formatShortcut(id, platform) : whole
  );
}
