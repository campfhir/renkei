/**
 * The pure half of the sandbox browser — what a page looks like to a model,
 * and the bounds every browser session runs under. The Playwright side
 * (launching Chromium, holding one context per caller, walking the DOM)
 * lives in apps/worker-sandbox/src/browser.ts; this module is the shared
 * vocabulary the worker produces and the web app's sandbox_browser_* tools
 * consume, so a ref is validated and a snapshot rendered the same way on
 * both ends.
 *
 * A snapshot is deliberately NOT raw HTML: it is a flat, ordered list of
 * the things a person would see and could act on — headings, text,
 * links, form controls — with every interactive element carrying a short
 * ref (`e12`) the worker has stamped onto the live DOM. The model acts by
 * ref, never by CSS selector or by generating script, which keeps every
 * browser verb a bounded, named thing the worker does itself.
 */

/** How long an idle browser session (one caller's context) lives before the worker closes it. */
export const BROWSER_SESSION_IDLE_MS = 10 * 60_000; // 10 minutes

/** Concurrent browser contexts the worker holds at once; the least recently used is evicted beyond this. */
export const BROWSER_MAX_SESSIONS = 8;

/** Ceiling for one page navigation (goto / the load a click triggers). */
export const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;

/** Ceiling for one in-page action (click, fill, select, key press). */
export const BROWSER_ACTION_TIMEOUT_MS = 10_000;

/** After a navigation or click, how long to wait for the network to go quiet before snapshotting. */
export const BROWSER_SETTLE_TIMEOUT_MS = 3_000;

/** Snapshot text returned to the model, unless the caller asks for less. */
export const BROWSER_SNAPSHOT_DEFAULT_CHARS = 20_000;

/** The most snapshot text any one call may ask for. */
export const BROWSER_SNAPSHOT_MAX_CHARS = 80_000;

/** Elements the in-page walk stops at — a bound on both DOM work and snapshot size. */
export const BROWSER_SNAPSHOT_MAX_NODES = 2_000;

/** Longest text the model may type into one field in one call. */
export const BROWSER_TYPE_MAX_CHARS = 10_000;

/** The viewport every session opens with. */
export const BROWSER_VIEWPORT = { width: 1280, height: 900 } as const;

/** Interactive roles the in-page walk assigns refs to. */
export type BrowserInteractiveRole =
  | 'link'
  | 'button'
  | 'textbox'
  | 'searchbox'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'slider'
  | 'switch'
  | 'tab'
  | 'menuitem'
  | 'option'
  | 'editable'
  | 'file';

/** Structural (non-interactive) content the walk reports without a ref. */
export type BrowserContentRole = 'heading' | 'text' | 'image' | 'landmark';

/** One line of a page snapshot, as the in-page walk emits it. */
export interface BrowserSnapshotNode {
  role: BrowserInteractiveRole | BrowserContentRole;
  /** Accessible name / visible text, already collapsed and trimmed. */
  name: string;
  /** Present on interactive elements only — the handle the model acts with. */
  ref?: string;
  /** Current value of a text-like control, or the selected option label(s). */
  value?: string;
  /** Absolute target of a link. */
  href?: string;
  /** Heading level 1-6. */
  level?: number;
  checked?: boolean;
  disabled?: boolean;
  /** Option labels of a select, bounded by the walk. */
  options?: string[];
  /** The DOM tag, for landmarks (nav, main, form, ...). */
  tag?: string;
}

/** What every browser verb answers with: where the page is now, and what's on it. */
export interface BrowserPageState {
  url: string;
  title: string;
  /** Rendered by `renderBrowserSnapshot`; already bounded by the caller's maxChars. */
  snapshot: string;
  /** True when the snapshot was cut at maxChars or the node ceiling. */
  truncated: boolean;
}

const REF_PATTERN = /^e\d{1,5}$/;

/** A ref the in-page walk could have minted — `e1`..`e99999`. */
export function isBrowserRef(value: unknown): value is string {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

/**
 * Clamp a caller's requested snapshot size into [1, BROWSER_SNAPSHOT_MAX_CHARS],
 * defaulting when absent or not a usable number.
 */
export function snapshotCharsOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return BROWSER_SNAPSHOT_DEFAULT_CHARS;
  }
  return Math.min(Math.floor(value), BROWSER_SNAPSHOT_MAX_CHARS);
}

function quoted(text: string): string {
  return JSON.stringify(text);
}

/** One snapshot node as a line of the rendered snapshot. */
export function renderSnapshotNode(node: BrowserSnapshotNode): string {
  switch (node.role) {
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(node.level ?? 1, 1), 6))} ${node.name}`;
    case 'text':
      return node.name;
    case 'image':
      return `[image ${quoted(node.name)}]`;
    case 'landmark':
      return `<${node.tag ?? 'section'}${node.name ? ` ${quoted(node.name)}` : ''}>`;
    default: {
      const parts: string[] = [`[${node.ref ?? '?'}] ${node.role}`];
      if (node.name) parts.push(quoted(node.name));
      if (node.value !== undefined && node.value !== '') parts.push(`= ${quoted(node.value)}`);
      if (node.href) parts.push(`→ ${node.href}`);
      if (node.checked !== undefined) parts.push(node.checked ? '(checked)' : '(unchecked)');
      if (node.disabled) parts.push('(disabled)');
      if (node.options && node.options.length > 0) {
        parts.push(`options: ${node.options.map(quoted).join(', ')}`);
      }
      return parts.join(' ');
    }
  }
}

/**
 * Render a walked page into the text a model reads, bounded by `maxChars`.
 * The header (title + URL) always survives; the body is cut at a line
 * boundary and a trailing note says so, so the model knows to ask for
 * more or scroll rather than assume the page ended.
 */
export function renderBrowserSnapshot(
  page: { url: string; title: string },
  nodes: readonly BrowserSnapshotNode[],
  maxChars: number,
  walkTruncated = false
): { snapshot: string; truncated: boolean } {
  const header = `Page: ${page.title || '(untitled)'}\nURL: ${page.url}\n---\n`;
  const budget = Math.max(0, maxChars - header.length);
  const lines: string[] = [];
  let used = 0;
  let truncated = walkTruncated;
  for (const node of nodes) {
    const line = renderSnapshotNode(node);
    if (used + line.length + 1 > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const body = lines.join('\n');
  const note = truncated
    ? `\n[snapshot truncated at ${lines.length} of ${nodes.length}${walkTruncated ? '+' : ''} items — ask for more with a larger maxChars]`
    : '';
  return { snapshot: `${header}${body}${note}`, truncated };
}
