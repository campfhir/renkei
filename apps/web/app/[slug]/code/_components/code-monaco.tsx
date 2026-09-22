'use client';

/**
 * The code pane's editor on a screen with a pointer: Monaco, self-hosted
 * (lib/monaco/setup.ts), one model per file path so each open file keeps
 * its own undo history across tab switches. Colouring by the built-in
 * tokenizers only — no language service, since the client has no
 * project-wide types and an underline that lies is worse than none.
 * Loaded on demand by code-editor.tsx; never rendered on the server.
 */

import { useEffect, useRef } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { configureMonacoOnce } from '@/lib/monaco/setup';
import { useMonacoDark } from '@/lib/monaco/use-dark-theme';
import { LoadingLine } from '@/components/skeleton';

configureMonacoOnce();

export interface CodeMonacoProps {
  path: string;
  language: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

export default function CodeMonaco({
  path,
  language,
  value,
  readOnly,
  onChange,
  onSave,
}: CodeMonacoProps) {
  const dark = useMonacoDark();
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  }, [onSave]);
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);

  const onMount: OnMount = (instance, monaco: Monaco) => {
    editorRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current());
  };

  return (
    <Editor
      height="100%"
      theme={dark ? 'vs-dark' : 'vs'}
      path={`file:///${path}`}
      language={language}
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
      }}
      loading={<LoadingLine size="xs" className="p-3" label="Loading editor…" />}
    />
  );
}
