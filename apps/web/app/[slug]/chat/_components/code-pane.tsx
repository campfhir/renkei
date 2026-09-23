'use client';

/**
 * A tool call's input or result as a coloured pane. The input is JSON by
 * construction, and it is coloured as such even while it streams in; a
 * result is coloured only when it parses as JSON (most tools answer with
 * it) and left plain otherwise — see guessPaneLanguage. The highlighter
 * returns a hast tree, walked here into spans that carry the same
 * `hljs-…` classes the Markdown code blocks use, so one palette in
 * globals.css colours both. A pane past HIGHLIGHT_LIMIT is shown plain:
 * colouring a 200 KB result costs more than it shows.
 */

import { useMemo, type ReactNode } from 'react';
import { codeHighlighter } from '@/lib/chat/code-grammars';
import { guessPaneLanguage, HIGHLIGHT_LIMIT } from '@/lib/chat/code-languages';

/** The slice of a hast node this file walks; hast's own types aren't a direct dependency. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function toReact(nodes: HastNode[] | undefined, prefix: string): ReactNode[] {
  return (nodes ?? []).map((node, index) => {
    const key = `${prefix}${index}`;
    if (node.type === 'text') return node.value ?? '';
    if (node.type !== 'element') return null;
    const classes = node.properties?.className;
    const className = Array.isArray(classes) ? classes.join(' ') : undefined;
    return (
      <span key={key} className={className}>
        {toReact(node.children, `${key}.`)}
      </span>
    );
  });
}

/** Coloured tokens for `text`, or the text itself when it is best left plain. */
export function highlightedTokens(text: string, language: string | undefined): ReactNode {
  if (!language || text.length > HIGHLIGHT_LIMIT) return text;
  const highlighter = codeHighlighter();
  if (!highlighter.registered(language)) return text;
  return toReact(highlighter.highlight(language, text).children, '');
}

export default function CodePane({
  text,
  language,
  className = 'chat-pre',
}: {
  text: string;
  /** Known up front (a tool's JSON input), or guessed from the text when omitted. */
  language?: string;
  className?: string;
}) {
  const tokens = useMemo(
    () => highlightedTokens(text, language ?? guessPaneLanguage(text)),
    [text, language]
  );
  return <pre className={className}>{tokens}</pre>;
}
