/**
 * What a change to the person's preferences, made somewhere other than the
 * form that shows them (lib/preferences-events.ts), re-renders — decided
 * here, with no DOM and no network; the components do the re-reading.
 *
 * - The shell (preferences-sync.tsx) asks the server for the page again
 *   when a document it renders from moved: the theme and the line-number
 *   gutter come down with the layout, the Preferences page's cards with
 *   the page. Voice, notifications and the rest have their own readers and
 *   cost the shell nothing.
 * - The thread re-reads its voice settings when `voice` moved.
 * - The tools dialog forgets its catalog when `defaultTools` moved, so the
 *   next opening shows the defaults as they now are.
 *
 * And which turns changed preferences at all: a browser that missed the
 * live event (it reconnected, or the turn ran on another replica) still
 * sees the call in the turn's rows, and announces the change itself.
 *
 * Tested in preferences-sync.model.test.ts.
 */

/** The tool that changes preferences (lib/chat/platform-tools/preferences.ts). */
export const SET_PREFERENCES_TOOL = 'renkei_set_preferences';

/** The documents the server-rendered shell and pages draw from. */
const SHELL_DOCUMENTS: ReadonlySet<string> = new Set([
  'theme',
  'notifications',
  'coachMarks',
  'chatArchive',
  'image',
  'defaultTools',
]);

/** The shell re-renders the server's copy when one of its documents moved. */
export function shellRefreshes(documents: readonly string[]): boolean {
  return documents.some((name) => SHELL_DOCUMENTS.has(name));
}

/** The theme rides on the shell: its mode and the gutter are applied from the fresh render. */
export function themeChanged(documents: readonly string[]): boolean {
  return documents.includes('theme');
}

/** The thread's voice menu holds its own copy of the voice settings. */
export function voiceReloads(documents: readonly string[]): boolean {
  return documents.includes('voice');
}

/** The tools dialog holds its own copy of the default toolsets. */
export function defaultToolsReload(documents: readonly string[]): boolean {
  return documents.includes('defaultTools');
}

interface CallBlock {
  type: string;
  name?: string;
  input?: unknown;
}

interface TurnMessage {
  turnId: string | null;
  blocks: readonly CallBlock[];
}

/** Every document a patch could name; what a call the page cannot read is taken to have touched. */
const ANY_DOCUMENT: readonly string[] = ['theme', 'voice', ...SHELL_DOCUMENTS].filter(
  (name, index, all) => all.indexOf(name) === index
);

/**
 * The documents a finished turn's calls to the preference tool named, for
 * the announcement at its end. Empty when the turn made no such call. A
 * call that was refused or failed names them all the same: re-reading
 * preferences that did not move costs a request and shows nothing wrong.
 */
export function documentsChangedIn(messages: readonly TurnMessage[], turnId: string): string[] {
  const named = new Set<string>();
  for (const message of messages) {
    if (message.turnId !== turnId) continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || block.name !== SET_PREFERENCES_TOOL) continue;
      const input = block.input;
      const keys =
        typeof input === 'object' && input !== null && !Array.isArray(input)
          ? Object.keys(input)
          : [];
      for (const key of keys.length > 0 ? keys : ANY_DOCUMENT) named.add(key);
    }
  }
  return [...named];
}
