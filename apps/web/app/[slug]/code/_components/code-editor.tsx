'use client';

/**
 * One editor behind one interface: Monaco on a screen with a pointer
 * (code-monaco.tsx, loaded on demand so a chat that never opens the pane
 * never downloads it), and on a touch screen a plain monospace text area
 * with a row of accessory keys above the keyboard — Monaco on a phone
 * keyboard is a known bad time, and the text area is a fraction of the
 * bundle. The text area is still coloured: the same text is drawn beneath
 * it, tokenised by the chat's highlighter, with the text area's own glyphs
 * transparent and its caret and selection on top; the two share every
 * font metric and scroll together, so the colours sit exactly under the
 * letters being typed. Nothing above this component knows which is
 * mounted.
 */

import dynamic from 'next/dynamic';
import { useMemo, useRef, type KeyboardEvent, type UIEvent } from 'react';
import { highlightedTokens } from '@/components/code-tokens';
import { LoadingLine } from '@/components/skeleton';
import { highlighterLanguageFor } from '@/lib/code/language';
import type { LanguageServersHandle } from './use-language-servers';

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
  /** The pane's language servers; Monaco attaches the file to its language's. The text area has none. */
  lsp: LanguageServersHandle | null;
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

function TextAreaEditor({ path, language, value, readOnly, onChange, onSave }: CodeEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLPreElement>(null);
  const tokens = useMemo(
    () => highlightedTokens(value, highlighterLanguageFor(language)),
    [value, language]
  );
  // The backdrop follows the text area's scroll, never the other way round.
  const onScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const pre = backdrop.current;
    if (!pre) return;
    pre.scrollTop = event.currentTarget.scrollTop;
    pre.scrollLeft = event.currentTarget.scrollLeft;
  };

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
      <div className="relative min-h-0 flex-1 bg-white dark:bg-gray-950">
        <pre ref={backdrop} aria-hidden className="code-area-backdrop code-tokens">
          {tokens}
          {'\n'}
        </pre>
        <textarea
          ref={area}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onScroll={onScroll}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          wrap="off"
          aria-label={`Contents of ${path}`}
          className="code-area-input"
        />
      </div>
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
