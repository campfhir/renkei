'use client';

/**
 * The code pane's editor on a screen with a pointer: Monaco, self-hosted
 * (lib/monaco/setup.ts), one model per file path so each open file keeps
 * its own undo history across tab switches. Colouring by the built-in
 * tokenizers; everything smarter — diagnostics, completion, hover, go to
 * definition, references, formatting, semantic colours — from the
 * language server the sandbox worker runs for the file's language
 * (use-language-servers.ts, lib/lsp), when it has one. TypeScript and
 * JavaScript files are Monaco languages of the pane's own
 * (`paneLanguageId`), so Monaco's single-file TypeScript worker never
 * attaches to them. Loaded on demand by code-editor.tsx; never rendered
 * on the server.
 */

import { useEffect, useRef, useState } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { configureMonacoOnce, MONACO_THEME } from '@/lib/monaco/setup';
import { paneLanguageId } from '@/lib/monaco/pane-languages';
import { useMonacoDark } from '@/lib/monaco/use-dark-theme';
import { LoadingLine } from '@/components/skeleton';
import { modelPath, type LanguageServersHandle } from './use-language-servers';

configureMonacoOnce();

export interface CodeMonacoProps {
  path: string;
  language: string;
  value: string;
  readOnly: boolean;
  lsp: LanguageServersHandle | null;
  onChange: (value: string) => void;
  onSave: () => void;
}

export default function CodeMonaco({
  path,
  language,
  value,
  readOnly,
  lsp,
  onChange,
  onSave,
}: CodeMonacoProps) {
  const dark = useMonacoDark();
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  }, [onSave]);
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const [mounted, setMounted] = useState(false);

  const onMount: OnMount = (instance, monaco: Monaco) => {
    editorRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current());
    lsp?.editorMounted(monaco, instance);
    setMounted(true);
  };

  // The file on screen is the one its language's server is told about.
  // The wrapper switches the model as `path` changes, in its own effect,
  // which runs before this one.
  useEffect(() => {
    const editor = editorRef.current;
    if (!mounted || !editor || !lsp) return;
    const model = editor.getModel();
    if (model && model.uri.toString() === monacoUri(model, path)) {
      lsp.modelShown(model, path, language);
    }
  }, [mounted, path, language, lsp]);

  useEffect(() => {
    return () => {
      if (editorRef.current) lsp?.editorUnmounted(editorRef.current);
    };
    // Unmount only: the handle is stable for the pane's life.
  }, []);

  return (
    <Editor
      height="100%"
      theme={dark ? MONACO_THEME.dark : MONACO_THEME.light}
      path={modelPath(path)}
      language={paneLanguageId(language)}
      value={value}
      onChange={(next) => onChange(next ?? '')}
      onMount={onMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 12.5,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderLineHighlight: 'line',
        wordWrap: 'off',
        tabSize: 2,
        padding: { top: 8 },
        // The pane has its own status line; Monaco's own overview ruler
        // and glyph margin would only take width from a narrow pane.
        glyphMargin: false,
        overviewRulerBorder: false,
        readOnlyMessage: { value: 'This file is read-only here.' },
        // A language server's semantic tokens colour over the tokenizer's.
        'semanticHighlighting.enabled': true,
      }}
      loading={<LoadingLine size="xs" className="p-3" label="Loading editor…" />}
    />
  );
}

/** The model's URI as Monaco spells it for this path, for the same-file check. */
function monacoUri(model: MonacoEditorNs.ITextModel, path: string): string {
  return model.uri.with({ path: `/${path}` }).toString();
}
