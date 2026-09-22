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
 */

import { loader } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';

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

  loader.config({ monaco: monacoEditor });
}
