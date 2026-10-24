/**
 * The app's global keyboard shortcuts, and how each is written for the
 * keyboard in front of the person: ⌘ K on a Mac, Ctrl K elsewhere. Pure, so
 * the labels, the matching and the coach-mark copy can be unit-tested.
 *
 * Two kinds:
 *
 *  - Chords (⌘/Ctrl + a key) work everywhere, a text field included.
 *  - Sequences are bare keys typed one after another — `c`, `a` `g` — and
 *    only count when the person is not typing in a field or looking at a
 *    dialog (see `isTypingTarget`). A sequence that begins another (`c`,
 *    and `c` `h`) waits a moment for the longer one before it fires.
 *
 * Chords match by the physical key (`event.code`), not the character: on a
 * Mac, Option turns J into "∆". Sequences match the character typed
 * (`event.key`), so they follow the person's keyboard layout.
 *
 * Browsers keep Ctrl/⌘+N, +T, +W and Ctrl+Tab for themselves — a page cannot
 * intercept them. On a Mac, ⌘ , (Preferences) belongs to the browser's menu
 * and some browsers do not pass it to the page either.
 */

export type Platform = 'mac' | 'other';

export type ChordId = 'search' | 'switch-chat' | 'tutorials' | 'preferences' | 'organization';

export type SequenceId =
  | 'new-chat'
  | 'chat-history'
  | 'code'
  | 'agents'
  | 'home'
  | 'knowledge'
  | 'files'
  | 'artifacts'
  | 'projects'
  | 'prompts'
  | 'memory'
  | 'notifications';

export type ShortcutId = ChordId | SequenceId;

interface ChordDef {
  /** `event.code` of the key. */
  code: string;
  /** The label of the key itself. */
  key: string;
  /** Command (⌘) on a Mac, Control elsewhere. */
  mod?: boolean;
  /** Option (⌥) on a Mac, Alt elsewhere. */
  alt?: boolean;
  shift?: boolean;
  /** The key's own label already says Shift (`?`), so no Shift cap is drawn. */
  shiftImplied?: boolean;
}

export const CHORDS: Record<ChordId, ChordDef> = {
  search: { code: 'KeyK', key: 'K', mod: true },
  'switch-chat': { code: 'KeyJ', key: 'J', mod: true },
  tutorials: { code: 'Slash', key: '?', mod: true, shift: true, shiftImplied: true },
  preferences: { code: 'Comma', key: ',', mod: true },
  organization: { code: 'Comma', key: ',', mod: true, shift: true },
};

interface SequenceDef {
  /** The characters typed, in order. */
  keys: string[];
  /** Where it goes; absent for the two that open a dialog. */
  href?: string;
}

export const SEQUENCES: Record<SequenceId, SequenceDef> = {
  'new-chat': { keys: ['c'] },
  'chat-history': { keys: ['c', 'h'] },
  code: { keys: ['\\', 'c'], href: '/code' },
  agents: { keys: ['a', 'g'], href: '/agents' },
  home: { keys: ['h', 'o'], href: '/' },
  knowledge: { keys: ['k', 'n'], href: '/knowledge' },
  files: { keys: ['f', 'i'], href: '/files' },
  artifacts: { keys: ['a', 'r'], href: '/chat/artifacts' },
  projects: { keys: ['p', 'r'], href: '/chat/projects' },
  prompts: { keys: ['p', 'l'], href: '/chat/prompts' },
  memory: { keys: ['m', 'e'], href: '/chat/memory' },
  notifications: { keys: ['n', 'o'], href: '/notifications' },
};

/** Where the chords that only navigate go. */
export const CHORD_HREFS: Partial<Record<ChordId, string>> = {
  tutorials: '/tutorials',
  preferences: '/preferences',
  organization: '/admin',
};

/** How long a key that could begin a longer sequence waits for the next. */
export const SEQUENCE_WAIT_MS = 600;

export function isChordId(id: string): id is ChordId {
  return Object.hasOwn(CHORDS, id);
}

export function isSequenceId(id: string): id is SequenceId {
  return Object.hasOwn(SEQUENCES, id);
}

function isShortcutId(id: string): id is ShortcutId {
  return isChordId(id) || isSequenceId(id);
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
  if (isSequenceId(id)) return SEQUENCES[id].keys.map((key) => key.toUpperCase());
  const def = CHORDS[id];
  const mac = platform === 'mac';
  const shift = def.shift && !def.shiftImplied ? [mac ? '⇧' : 'Shift'] : [];
  const mod = def.mod ? [mac ? '⌘' : 'Ctrl'] : [];
  const alt = def.alt ? [mac ? '⌥' : 'Alt'] : [];
  // A Mac writes Shift before Command (⇧⌘,); elsewhere Ctrl comes first.
  return mac ? [...shift, ...alt, ...mod, def.key] : [...mod, ...alt, ...shift, def.key];
}

/** "⌘ K" or "Ctrl K" — the keys as one line of text. */
export function formatShortcut(id: ShortcutId, platform: Platform): string {
  // Bare keys are typed one after another: "A then G".
  return shortcutKeys(id, platform).join(isSequenceId(id) ? ' then ' : ' ');
}

/** Whether a keydown is this chord — exactly its modifiers, no others. */
export function matchesShortcut(
  id: ChordId,
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  platform: Platform,
  /** Accept Shift too — a switcher walks backwards with it. */
  anyShift = false
): boolean {
  const def = CHORDS[id];
  if (event.code !== def.code) return false;
  const modDown = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const modOther = platform === 'mac' ? event.ctrlKey : event.metaKey;
  return (
    modDown === Boolean(def.mod) &&
    !modOther &&
    event.altKey === Boolean(def.alt) &&
    (anyShift || event.shiftKey === Boolean(def.shift))
  );
}

/** What typing one more key does to a sequence in progress. */
export type SequenceStep =
  | { kind: 'none' }
  /** Waiting for more keys; `fire` is what a pause settles on, if anything. */
  | { kind: 'pending'; buffer: string[]; fire: SequenceId | null }
  | { kind: 'fire'; id: SequenceId };

/**
 * The keys typed so far plus one more. An exact match nothing longer begins
 * fires at once; one that is also the start of a longer sequence waits (and
 * is what a pause fires). Keys that lead nowhere start over from the new
 * key, so a stray letter does not eat the next sequence.
 */
export function stepSequence(buffer: readonly string[], key: string): SequenceStep {
  const next = [...buffer, key.toLowerCase()];
  let exact: SequenceId | null = null;
  let longer = false;
  for (const [id, def] of Object.entries(SEQUENCES)) {
    if (!isSequenceId(id)) continue;
    const keys = def.keys;
    if (keys.length === next.length && keys.every((k, i) => k === next[i])) exact = id;
    else if (keys.length > next.length && next.every((k, i) => k === keys[i])) longer = true;
  }
  if (longer) return { kind: 'pending', buffer: next, fire: exact };
  if (exact) return { kind: 'fire', id: exact };
  return buffer.length > 0 ? stepSequence([], key) : { kind: 'none' };
}

/** The slice of an element `isTypingTarget` reads — a DOM Element fits. */
export interface TypingTarget {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
}

/**
 * Whether keys typed at this element are text: a field, an editor, or
 * anything that says it is one. Bare-key shortcuts stand down there.
 */
export function isTypingTarget(target: TypingTarget | null): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute?.('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/**
 * Coach-mark copy names a shortcut as `{shortcut:new-chat}`; the tour card
 * swaps in the keys for this person's keyboard.
 */
export function expandShortcutTokens(text: string, platform: Platform): string {
  return text.replace(/\{shortcut:([a-z-]+)\}/g, (whole, id: string) =>
    isShortcutId(id) ? formatShortcut(id, platform) : whole
  );
}
