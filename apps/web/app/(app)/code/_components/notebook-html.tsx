'use client';

/**
 * A notebook output's HTML (a DataFrame's table, mostly), drawn safely.
 *
 * The HTML is whatever the repository's notebook holds — text from
 * outside, in a page signed in as the person — so it is never put into
 * the document as markup. The browser parses it into a detached document
 * (where nothing runs and nothing loads), and what is drawn is rebuilt
 * from that tree as React elements, keeping only an allowlist: tables
 * and plain text structure, links to http(s) opened elsewhere, and
 * images carried inline as data. Scripts, styles, frames, forms, event
 * handlers, inline styles and anything that would fetch from another
 * host are dropped; an unknown element keeps its text.
 */

import { createElement, useMemo, type ReactNode } from 'react';

const KEPT = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'div',
  'span',
  'p',
  'br',
  'hr',
  'b',
  'i',
  'u',
  's',
  'strong',
  'em',
  'code',
  'pre',
  'kbd',
  'sub',
  'sup',
  'small',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'details',
  'summary',
]);

/** Dropped with everything inside them. */
const REMOVED = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'object',
  'embed',
  'link',
  'meta',
  'head',
  'title',
  'template',
  'noscript',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'video',
  'audio',
  'canvas',
  'base',
]);

const VOID = new Set(['br', 'hr', 'img']);
const MAX_NODES = 20_000;

function span(value: string | null): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 1 && parsed <= 1000 ? parsed : undefined;
}

function build(node: Node, key: string, budget: { left: number }): ReactNode {
  if (budget.left <= 0) return null;
  budget.left -= 1;
  if (node.nodeType === 3) return node.textContent;
  if (!(node instanceof Element)) return null;
  const element = node;
  const tag = element.tagName.toLowerCase();
  if (REMOVED.has(tag)) return null;
  const children = VOID.has(tag)
    ? undefined
    : Array.from(element.childNodes).map((child, index) => build(child, `${key}.${index}`, budget));
  if (!KEPT.has(tag)) return children;
  const props: Record<string, unknown> = { key };
  if (tag === 'a') {
    const href = element.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return children;
    props.href = href;
    props.target = '_blank';
    props.rel = 'noopener noreferrer nofollow';
  } else if (tag === 'img') {
    const src = element.getAttribute('src') ?? '';
    if (!/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) return null;
    props.src = src;
    props.alt = element.getAttribute('alt') ?? '';
  } else if (tag === 'td' || tag === 'th') {
    props.colSpan = span(element.getAttribute('colspan'));
    props.rowSpan = span(element.getAttribute('rowspan'));
  }
  return createElement(tag, props, children);
}

export default function NotebookHtml({ html }: { html: string }) {
  const content = useMemo(() => {
    if (typeof DOMParser === 'undefined') return null;
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const budget = { left: MAX_NODES };
    return Array.from(parsed.body.childNodes).map((child, index) =>
      build(child, String(index), budget)
    );
  }, [html]);
  return (
    <div className="notebook-html overflow-x-auto" data-testid="cell-html">
      {content}
    </div>
  );
}
