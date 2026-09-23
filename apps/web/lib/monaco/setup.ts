'use client';

/**
 * Monaco, SELF-HOSTED and configured once for the whole app.
 * `@monaco-editor/react` fetches from a CDN by default, which would put
 * a page behind a third-party request and break entirely in an
 * air-gapped install; `loader.config({ monaco })` points it at the
 * bundled copy instead.
 *
 * Only two workers are loaded — the editor's own and the TypeScript one
 * (the admin script editor's language service). Monaco ships six more
 * (JSON, CSS, HTML…) that nothing here has a use for, and each is a real
 * download. The code pane colours every file with the tokenizers alone.
 *
 * Two themes are defined here, `renkei-light` and `renkei-dark`: Monaco's
 * own `vs` and `vs-dark` with the token colours of the chat's code blocks
 * (the `--hl-*` palette in globals.css), so a file in the pane and the
 * same code quoted in a reply read alike. Monaco takes literal colours,
 * not CSS variables, so the palette is written out again here.
 */

import { loader } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';

export const MONACO_THEME = { light: 'renkei-light', dark: 'renkei-dark' } as const;

/** The chat's code palette, light and dark, as Monaco wants it: hex. */
const PALETTE = {
  light: {
    comment: '6b7280',
    keyword: '7e22ce',
    type: '0f766e',
    string: '047857',
    key: '0369a1',
    number: 'b45309',
    title: '1d4ed8',
    variable: 'be123c',
    punctuation: '6b7280',
    invalid: 'b91c1c',
    foreground: '171717',
    background: 'ffffff',
  },
  dark: {
    comment: '9ca3af',
    keyword: 'd8b4fe',
    type: '5eead4',
    string: '6ee7b7',
    key: '7dd3fc',
    number: 'fcd34d',
    title: '93c5fd',
    variable: 'fda4af',
    punctuation: '9ca3af',
    invalid: 'fca5a5',
    foreground: 'ededed',
    background: '0a0a0a',
  },
} as const;

/**
 * Monarch token names, by the role they play — a prefix matches every
 * token under it, and a `.<language>` suffix narrows one to a language
 * whose tokenizer names things unusually (YAML keys are `type`; JSON's
 * true/false/null are `keyword`).
 */
function themeRules(scheme: keyof typeof PALETTE): monacoEditor.editor.ITokenThemeRule[] {
  const c = PALETTE[scheme];
  return [
    { token: 'comment', foreground: c.comment, fontStyle: 'italic' },
    { token: 'keyword', foreground: c.keyword },
    { token: 'keyword.json', foreground: c.number },
    { token: 'metatag', foreground: c.keyword },
    { token: 'annotation', foreground: c.key },
    { token: 'type', foreground: c.type },
    { token: 'type.yaml', foreground: c.key },
    { token: 'namespace', foreground: c.type },
    { token: 'predefined', foreground: c.type },
    { token: 'string', foreground: c.string },
    { token: 'string.key', foreground: c.key },
    { token: 'string.escape', foreground: c.number },
    { token: 'regexp', foreground: c.string },
    { token: 'attribute.value', foreground: c.string },
    { token: 'attribute.name', foreground: c.key },
    { token: 'key', foreground: c.key },
    { token: 'number', foreground: c.number },
    { token: 'constant', foreground: c.number },
    { token: 'tag', foreground: c.title },
    { token: 'variable', foreground: c.variable },
    { token: 'delimiter', foreground: c.punctuation },
    { token: 'operator', foreground: c.punctuation },
    { token: 'invalid', foreground: c.invalid },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'emphasis', fontStyle: 'italic' },
  ];
}

function defineThemes(): void {
  for (const scheme of ['light', 'dark'] as const) {
    monacoEditor.editor.defineTheme(MONACO_THEME[scheme], {
      base: scheme === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: themeRules(scheme),
      colors: {
        'editor.foreground': `#${PALETTE[scheme].foreground}`,
        'editor.background': `#${PALETTE[scheme].background}`,
      },
    });
  }
}

let configured = false;

export function configureMonacoOnce(): void {
  if (configured || typeof window === 'undefined') return;
  configured = true;

  // Turbopack resolves these `new URL(..., import.meta.url)` worker
  // specifiers at build time; anything else (a string path, a CDN URL)
  // would resolve to nothing in production.
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === 'typescript' || label === 'javascript') {
        return new Worker(
          new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
          { type: 'module' }
        );
      }
      return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
        type: 'module',
      });
    },
  };

  defineThemes();
  loader.config({ monaco: monacoEditor });
}
