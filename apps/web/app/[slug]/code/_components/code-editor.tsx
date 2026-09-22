'use client';

/**
 * One editor behind one interface: Monaco on a screen with a pointer
 * (code-monaco.tsx, loaded on demand so a chat that never opens the pane
 * never downloads it), and on a touch screen a plain monospace text area
 * with a row of accessory keys above the keyboard — Monaco on a phone
 * keyboard is a known bad time, and the text area is a fraction of the
 * bundle. Nothing above this component knows which is mounted.
 */

import dynamic from 'next/dynamic';
import { useRef, type KeyboardEvent } from 'react';
import { LoadingLine } from '@/components/skeleton';

const CodeMonaco = dynamic(() => import('./code-monaco'), {
  ssr: false,
  loading: () => <LoadingLine size="xs" className="p-3" label="Loading editor…" />,
});

export interface CodeEditorProps {
  path: string;
  language: string;
  value: string;
  readOnly: boolean;
  /** A touch screen: the text area, not Monaco. */
  touch: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

export default function CodeEditor(props: CodeEditorProps) {
  if (props.touch) return <TextAreaEditor {...props} />;
  return <CodeMonaco {...props} />;
}

/** The keys a phone keyboard hides that code needs most. */
const ACCESSORY_KEYS: { label: string; insert: string; cursorBack?: number }[] = [
  { label: '⇥', insert: '  ' },
  { label: '{ }', insert: '{}', cursorBack: 1 },
  { label: '( )', insert: '()', cursorBack: 1 },
  { label: '[ ]', insert: '[]', cursorBack: 1 },
  { label: '=>', insert: '=>' },
  { label: ';', insert: ';' },
  { label: "'", insert: "''", cursorBack: 1 },
  { label: '"', insert: '""', cursorBack: 1 },
  { label: '`', insert: '``', cursorBack: 1 },
];

function TextAreaEditor({ path, value, readOnly, onChange, onSave }: CodeEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);

  const insert = (text: string, cursorBack = 0) => {
    const element = area.current;
    if (!element || readOnly) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    // After React re-renders, put the caret where typing continues.
    requestAnimationFrame(() => {
      const at = start + text.length - cursorBack;
      element.setSelectionRange(at, at);
      element.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
    } else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      insert('  ');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <textarea
        ref={area}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        wrap="off"
        aria-label={`Contents of ${path}`}
        className="min-h-0 flex-1 resize-none bg-white p-3 font-mono text-[13px] leading-5 text-gray-900 outline-none dark:bg-gray-950 dark:text-gray-100"
      />
      {!readOnly ? (
        <div
          role="toolbar"
          aria-label="Keys"
          className="flex gap-1.5 overflow-x-auto border-t border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-800 dark:bg-gray-900"
        >
          {ACCESSORY_KEYS.map((key) => (
            <button
              key={key.label}
              type="button"
              onClick={() => insert(key.insert, key.cursorBack)}
              className="h-9 min-w-9 shrink-0 rounded-md border border-gray-300 bg-white px-2.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-950"
            >
              {key.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
