/**
 * Source text as coloured tokens, for any pane that is not Monaco: the
 * chat's tool-call panes, the touch-screen editor's backdrop, a compare
 * view. The highlighter returns a hast tree, walked here into spans that
 * carry the `hljs-…` classes the chat's Markdown code blocks use, so one
 * palette in globals.css (the `--hl-*` variables, under `.code-tokens`,
 * `.chat-pre` and `.chat-markdown`) colours all of them. Text past
 * HIGHLIGHT_LIMIT, or in a language the highlighter lacks, comes back as
 * it was: colouring a 200 KB file costs more than it shows.
 */

import type { ReactNode } from 'react';
import { codeHighlighter } from '@/lib/chat/code-grammars';
import { HIGHLIGHT_LIMIT } from '@/lib/chat/code-languages';

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
