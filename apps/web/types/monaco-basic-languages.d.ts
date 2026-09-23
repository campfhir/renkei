/**
 * Monaco ships its Monarch grammars as plain ESM without declarations;
 * the code pane reuses two of them under ids of its own
 * (lib/monaco/setup.ts), so here is their shape.
 */

declare module 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

declare module 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
