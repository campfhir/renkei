/**
 * Monaco ships its Monarch grammars as plain ESM without declarations;
 * the code pane reuses two of them under ids of its own
 * (lib/monaco/setup.ts), so here is their shape. The paths are the
 * exports-map form monaco-editor 0.56 introduced (`languages/definitions`).
 */

declare module 'monaco-editor/languages/definitions/typescript/typescript.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

declare module 'monaco-editor/languages/definitions/javascript/javascript.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
