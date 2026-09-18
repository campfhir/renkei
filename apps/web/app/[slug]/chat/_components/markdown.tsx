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
 * Token colors live in globals.css under `.chat-markdown` for both schemes.
 */

import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
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
  return (
    <div className="group relative">
      <pre>{children}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute top-1.5 right-1.5 rounded border border-gray-300 bg-white/90 px-1.5 py-0.5 text-[11px] text-gray-600 opacity-0 transition group-hover:opacity-100 focus:opacity-100 dark:border-gray-700 dark:bg-gray-900/90 dark:text-gray-300"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
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
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
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
