'use client';

/**
 * Whether a fenced code block shows its line-number gutter — this
 * person's Appearance preference (see ThemePrefs.codeLineNumbers),
 * read once by the tenant layout and handed down here so every place
 * that renders the chat's Markdown (the thread, a sub-agent's
 * transcript, a code project's README) agrees without each one
 * threading the value through its own props.
 *
 * A layout does not re-render on a client-side navigation (see its own
 * comment), so a change saved on the Preferences page takes effect
 * from the next full load — the same lag every other Appearance
 * preference already has.
 */

import { createContext, useContext } from 'react';

const CodeLineNumbersContext = createContext(false);

export const CodeLineNumbersProvider = CodeLineNumbersContext.Provider;

export function useCodeLineNumbers(): boolean {
  return useContext(CodeLineNumbersContext);
}
