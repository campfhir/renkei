/**
 * The code pane's own Monaco ids for TypeScript and JavaScript. Monaco's
 * TypeScript worker attaches itself to every `typescript` and
 * `javascript` model on the page — the admin script editor wants that,
 * one file with its types supplied — and cannot be detached from a
 * language once it has: it knows one file at a time and would underline
 * every import of a repository it cannot see, and it would double every
 * completion a real language server offers. So the pane's models speak
 * languages of their own, coloured by the very same Monarch tokenizers
 * and configured the same way (registered in setup.ts), that the worker
 * never hears of. Kept apart from setup.ts because that module imports
 * Monaco itself, which cannot load on the server, and the pane's state
 * hook needs these names on both sides.
 */

export const PANE_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  typescript: 'renkei-typescript',
  javascript: 'renkei-javascript',
};

/** The Monaco language id the code pane uses for a file's language. */
export function paneLanguageId(language: string): string {
  return PANE_LANGUAGE_ALIASES[language] ?? language;
}
