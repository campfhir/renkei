'use client';

/**
 * The cleaner-script editor: Monaco with the TypeScript language service.
 *
 * The point is not syntax colouring. It is that `email.` offers the fields
 * that actually exist, and a typo or a wrong type is underlined while you
 * type rather than discovered as a `last_error` on a row nobody is
 * watching. Script failures in production are silent by design — the text
 * passes through and the message indexes uncleaned — so the editor is the
 * only place a mistake can be made loud.
 *
 * Monaco is SELF-HOSTED. `@monaco-editor/react` fetches from a CDN by
 * default, which would put an admin page behind a third-party request and
 * break entirely in an air-gapped install; `loader.config({ monaco })`
 * points it at the bundled copy instead.
 *
 * Only two workers are loaded — the editor's own and the TypeScript one.
 * Monaco ships six more (JSON, CSS, HTML…) that this page has no use for,
 * and each is a real download.
 */

import { useEffect, useState } from 'react';
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';
import { CLEANER_TYPES } from '@/lib/email-sanitizer/cleaner-types';

let configured = false;

function configureOnce(): void {
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

configureOnce();

export interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Rendered height. The editor cannot size itself from content. */
  height?: number;
  ariaLabel?: string;
}

export default function ScriptEditor({
  value,
  onChange,
  height = 260,
  ariaLabel = 'Cleaner script source',
}: ScriptEditorProps) {
  // Driven as a PROP, not by monaco.editor.setTheme: the Editor component
  // applies its own `theme` at mount (defaulting to light), so an
  // imperative call made beforehand is overwritten and the editor comes up
  // white inside a dark page.
  const [dark, setDark] = useState(false);

  // The page has three theme states — explicit dark, explicit light, and
  // system — so both the data-theme attribute and the media query matter,
  // and either can change while the editor is open.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      setDark(
        document.documentElement.dataset.theme === 'dark' ||
          (document.documentElement.dataset.theme !== 'light' && media.matches)
      );
    };
    apply();
    media.addEventListener('change', apply);
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      media.removeEventListener('change', apply);
      observer.disconnect();
    };
  }, []);

  function handleBeforeMount(monaco: Monaco): void {
    const ts = monaco.languages.typescript;
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ES2020,
      lib: ['es2020'],
      strict: true,
      // Only the enums Monaco actually re-exports are safe to touch here.
      // `ModuleDetectionKind` is not one of them, and reading it threw at
      // module scope — which killed the whole editor, not just the option.
      allowNonTsExtensions: true,
    });
    ts.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      // "Declared but never read" on the one function being authored is
      // noise: nothing in the file calls it, by design.
      diagnosticCodesToIgnore: [6133, 6196],
    });
    ts.typescriptDefaults.setExtraLibs([
      { content: CLEANER_TYPES, filePath: 'file:///renkei/cleaner-email.d.ts' },
    ]);
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-gray-300 dark:border-gray-700"
      // Monaco renders into a canvas-like widget tree that screen readers
      // cannot follow; the label is what names the region.
      role="group"
      aria-label={ariaLabel}
    >
      <Editor
        height={height}
        theme={dark ? 'vs-dark' : 'vs'}
        // `language`, not `defaultLanguage`: the latter only applies when
        // the model is first created, and the model here was coming up as
        // JavaScript — which parses a type annotation as a value and turns
        // every correct script into four errors.
        language="typescript"
        path="file:///renkei/cleaner-script.ts"
        value={value}
        onChange={(next) => onChange(next ?? '')}
        beforeMount={handleBeforeMount}
        loading={
          <div className="p-3 text-xs text-gray-500 dark:text-gray-400">Loading editor…</div>
        }
        options={{
          minimap: { enabled: false },
          lineNumbers: 'on',
          fontSize: 12,
          tabSize: 2,
          scrollBeyondLastLine: false,
          // The card is narrow; wrapping beats a horizontal scrollbar.
          wordWrap: 'on',
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
        }}
      />
    </div>
  );
}
