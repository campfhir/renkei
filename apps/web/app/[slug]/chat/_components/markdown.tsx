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
 * language, the code beneath, and a small Copy affordance under it that
 * is always there (a hover-only button is no button on a phone). Untagged
 * fences are never guessed at; a listing coloured as the wrong language
 * misleads. Token colors live in globals.css under `.chat-markdown` for
 * both schemes.
 *
 * Line numbers are this person's Appearance preference
 * (useCodeLineNumbers, off by default). Every fenced block is split into
 * one <span class="chat-code-line"> per line regardless — a `hljs-…` span
 * that crosses a line break is reopened on each side of it — because a
 * literal "\n" text node is what the split removes; a CSS counter
 * numbers those spans when the preference is on. Nothing about a line's
 * number is ever a text node, so it never rides along with the code when
 * a person copies it, by the button below the block or by selecting the
 * text themselves.
 *
 * `variant="user"` is the same renderer for the person's own prompt
 * (message-list.tsx's UserMessage), so a fence or a backtick they typed
 * gets the identical card and monospace treatment a reply's does — with
 * one adjustment first: CommonMark treats a single newline inside a
 * paragraph as a soft break (rendered as a space), but every newline in a
 * typed prompt is a real Enter press and reads as a line break in the
 * composer already. `withHardBreaks` turns each of THOSE into a proper
 * hard break (two trailing spaces) before parsing, skipping the inside of
 * any fenced block, where a trailing space would corrupt the code.
 */

import { isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Icon, ICONS } from '@/components/icons';
import { useCodeLineNumbers } from '@/components/code-display-context';
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

/**
 * A hast element's own line, split at every "\n" a text node under it
 * carries. `lines[0]` continues whatever line was already open before
 * this node; `lines[last]` is left open for whatever follows; anything
 * in between is a line this node completed entirely on its own (a
 * multi-line string token, say). Every non-empty line is wrapped in a
 * clone of the node itself, so a `hljs-…` span reopens on each line it
 * crosses and keeps its colour.
 */
function splitHastLines(node: HastNode): HastNode[][] {
  if (node.type === 'text') {
    return (node.value ?? '')
      .split('\n')
      .map((part) => (part ? [{ type: 'text', value: part }] : []));
  }
  const children = node.children ?? [];
  if (node.type !== 'element' || children.length === 0) return [[node]];
  const lines = mergeHastLines(children);
  return lines.map((line) => (line.length > 0 ? [{ ...node, children: line }] : []));
}

/** Children split into lines and merged back together, one node's worth at a time. */
function mergeHastLines(children: HastNode[]): HastNode[][] {
  const lines: HastNode[][] = [[]];
  for (const child of children) {
    const childLines = splitHastLines(child);
    lines[lines.length - 1] = [...lines[lines.length - 1], ...childLines[0]];
    for (let index = 1; index < childLines.length; index++) lines.push(childLines[index]);
  }
  return lines;
}

/**
 * A fenced block's `<code>` children, one line per entry. A fenced
 * block's text ends in the newline before the closing fence — that
 * trailing split is the end of the block, not a blank line to number.
 */
function codeLines(children: HastNode[]): HastNode[][] {
  const lines = mergeHastLines(children);
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

/**
 * Rehype plugin: wraps every fenced block's code in one
 * <span class="chat-code-line"> per line (see the file header). Inline
 * code — a single backtick, never inside a <pre> — is left untouched.
 */
function rehypeCodeLines() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.tagName === 'pre') {
        const code = (node.children ?? []).find((child) => child.tagName === 'code');
        if (code) {
          code.children = codeLines(code.children ?? []).map((line) => ({
            type: 'element',
            tagName: 'span',
            properties: { className: ['chat-code-line'] },
            children: line,
          }));
        }
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

/** Whether a React element is one line of a fenced block (see rehypeCodeLines). */
function isCodeLine(className: unknown): boolean {
  const classes = Array.isArray(className) ? className.join(' ') : className;
  return typeof classes === 'string' && classes.split(/\s+/).includes('chat-code-line');
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lineNumbers = useCodeLineNumbers();
  const text = textOf(children);
  const label = languageLabel(languageOf(children));
  return (
    <div className={lineNumbers ? 'chat-code line-numbers' : 'chat-code'}>
      <div className="chat-code-head">
        <span className="chat-code-lang">{label ?? ''}</span>
      </div>
      <pre>{children}</pre>
      <div className="chat-code-foot">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="chat-code-copy"
          aria-label={copied ? 'Copied' : 'Copy'}
          title={copied ? 'Copied' : 'Copy'}
        >
          <Icon path={copied ? ICONS.check : ICONS.copy} className="h-3.5 w-3.5" />
        </button>
      </div>
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

/**
 * The text inside a highlighted <code> tree, for the copy button — each
 * chat-code-line (see rehypeCodeLines) puts its own newline back, since
 * splitting the block into lines is what took the literal "\n" out.
 */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props: { children?: ReactNode; className?: unknown } =
      typeof node.props === 'object' && node.props !== null ? node.props : {};
    const text = textOf(props.children);
    return isCodeLine(props.className) ? `${text}\n` : text;
  }
  return '';
}

/** Every fenced block (```…```), left untouched by `withHardBreaks`. */
const FENCE = /(```[\s\S]*?```)/;

/** A lone "\n" — not one half of a blank-line paragraph break — as a CommonMark hard break. */
function hardBreakLines(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, '  \n');
}

function withHardBreaks(text: string): string {
  return text
    .split(FENCE)
    .map((part, index) => (index % 2 === 1 ? part : hardBreakLines(part)))
    .join('');
}

export default function Markdown({
  text,
  variant,
}: {
  text: string;
  /** 'user' colours links, code and tables for the solid blue prompt bubble instead of the reply's card. */
  variant?: 'user';
}) {
  return (
    <div
      className={variant === 'user' ? 'chat-markdown chat-markdown-user' : 'chat-markdown'}
      onCopy={(event) => {
        copySelectionWithMarkdownTables(event.nativeEvent);
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: false, languages: CODE_GRAMMARS, aliases: CODE_ALIASES }],
          rehypeCodeLines,
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
        {variant === 'user' ? withHardBreaks(text) : text}
      </ReactMarkdown>
    </div>
  );
}
