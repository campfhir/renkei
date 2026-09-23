'use client';

/**
 * The model's Markdown, as a React tree — never as HTML: react-markdown
 * builds elements straight from the syntax tree, raw HTML in the source is
 * skipped rather than injected, and the only overrides are ones that make
 * the output safe and usable (links open elsewhere and never carry a
 * referrer, code blocks copy, tables scroll instead of widening the page).
 * Each body cell also carries its column header as `data-label`, so on
 * narrow screens the stylesheet can stack a row into a "Header: value" card
 * instead of squeezing every column into a few characters' width. Copying
 * a selection that spans a table writes it back out as a Markdown table.
 *
 * A fenced code block is coloured by the grammar its fence names —
 * lowlight's common set plus the extras in lib/chat/code-grammars.ts,
 * under the aliases in lib/chat/code-languages.ts, so `postgres`, `ts`,
 * `yml` and `env` all colour — and shown as a card: a header naming the
 * language beside a Copy button that is always there (a hover-only
 * button is no button on a phone), the code beneath. Untagged fences are
 * never guessed at; a listing coloured as the wrong language misleads.
 * Token colors live in globals.css under `.chat-markdown` for both schemes.
 */

import { isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CODE_GRAMMARS } from '@/lib/chat/code-grammars';
import { CODE_ALIASES, languageFromClassName, languageLabel } from '@/lib/chat/code-languages';
import { copySelectionWithMarkdownTables } from './copy-tables-as-markdown';

/** The slice of a hast node this file walks; hast's own types aren't a direct dependency. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** All text under a node, for a header cell's label. */
function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

/** The rows of a table, whether or not they sit inside thead/tbody. */
function tableRows(table: HastNode): HastNode[] {
  return (table.children ?? []).flatMap((child) =>
    child.tagName === 'tr' ? [child] : (child.children ?? []).filter((row) => row.tagName === 'tr')
  );
}

/**
 * Rehype plugin: gives every <td> a `data-label` holding its column's header
 * text, so the stylesheet can print it before the value when the table is
 * shown as cards. Cells past the header row's width are left unlabelled.
 */
function rehypeTableLabels() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.tagName === 'table') {
        const rows = tableRows(node);
        const headers = (rows[0]?.children ?? [])
          .filter((cell) => cell.tagName === 'th')
          .map((cell) => hastText(cell).trim());
        for (const row of rows) {
          const cells = (row.children ?? []).filter((cell) => cell.tagName === 'td');
          cells.forEach((cell, index) => {
            const label = headers[index];
            if (label) cell.properties = { ...cell.properties, dataLabel: label };
          });
        }
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textOf(children);
  const label = languageLabel(languageOf(children));
  return (
    <div className="chat-code">
      <div className="chat-code-head">
        <span className="chat-code-lang">{label ?? ''}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="chat-code-copy"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** The fence's language word, from the `language-…` class on the <code> inside a <pre>. */
function languageOf(node: ReactNode): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = languageOf(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return undefined;
  return languageFromClassName(node.props.className) ?? languageOf(node.props.children);
}

/** The text inside a highlighted <code> tree, for the copy button. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props: { children?: ReactNode } =
      typeof node.props === 'object' && node.props !== null ? node.props : {};
    return textOf(props.children);
  }
  return '';
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div
      className="chat-markdown"
      onCopy={(event) => {
        copySelectionWithMarkdownTables(event.nativeEvent);
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: false, languages: CODE_GRAMMARS, aliases: CODE_ALIASES }],
          rehypeTableLabels,
        ]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="chat-table overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
