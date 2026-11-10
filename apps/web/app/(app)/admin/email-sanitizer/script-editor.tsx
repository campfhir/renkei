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
 * Monaco is self-hosted and configured once for the app (lib/monaco/setup.ts).
 * What it underlines is TypeScript's verdict on the script against
 * `CLEANER_TYPES` under the options below, not a rule of ours;
 * lib/email-sanitizer/cleaner-types.test.ts type-checks scripts the same
 * way in node.
 */

import Editor, { type Monaco } from '@monaco-editor/react';
import { CLEANER_IGNORED_DIAGNOSTICS, CLEANER_TYPES } from '@/lib/email-sanitizer/cleaner-types';
import { LoadingLine } from '@/components/skeleton';
import { configureMonacoOnce, MONACO_THEME } from '@/lib/monaco/setup';
import { useMonacoDark } from '@/lib/monaco/use-dark-theme';

configureMonacoOnce();

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
  const dark = useMonacoDark();

  function handleBeforeMount(monaco: Monaco): void {
    // monaco-editor 0.57 moved the TypeScript API from languages.typescript
    // (now a deprecated stub) to the top-level typescript namespace.
    const ts = monaco.typescript;
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
      diagnosticCodesToIgnore: [...CLEANER_IGNORED_DIAGNOSTICS],
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
        theme={dark ? MONACO_THEME.dark : MONACO_THEME.light}
        // `language`, not `defaultLanguage`: the latter only applies when
        // the model is first created, and the model here was coming up as
        // JavaScript — which parses a type annotation as a value and turns
        // every correct script into four errors.
        language="typescript"
        path="file:///renkei/cleaner-script.ts"
        value={value}
        onChange={(next) => onChange(next ?? '')}
        beforeMount={handleBeforeMount}
        loading={<LoadingLine size="xs" className="p-3" label="Loading editor…" />}
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
