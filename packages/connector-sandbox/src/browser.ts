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

/** Steps one sandbox_browser_run call may carry. */
export const BROWSER_RUN_MAX_STEPS = 20;

/** Longest single explicit wait, and the longest a wait-for-text will hold. */
export const BROWSER_WAIT_MAX_MS = 10_000;

/** Total explicit waiting one run may ask for — a run must fit inside one tool call's timeout. */
export const BROWSER_RUN_WAIT_BUDGET_MS = 20_000;

/** Longest text a wait step may look for. */
export const BROWSER_WAIT_TEXT_MAX_CHARS = 200;

/** Farthest one scroll step moves, in CSS pixels; the default is most of a viewport. */
export const BROWSER_SCROLL_MAX_PX = 10_000;
export const BROWSER_SCROLL_DEFAULT_PX = 720;

/** Options one select may choose at once. */
export const BROWSER_SELECT_MAX_VALUES = 50;

/** A key name for a press: `Enter`, `PageDown`, `Control+a`, at most three modifiers. */
export const BROWSER_KEY_PATTERN = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+){0,3}$/;
export const BROWSER_KEY_MAX_LENGTH = 40;

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
 * One thing the browser does, as both the single-verb tools and
 * sandbox_browser_run express it. A run is an ordered list of these,
 * executed in one round trip; refs in later steps must come from the
 * snapshot the caller already has, so a run is for working one page
 * (fill, select, scroll, wait, submit) rather than for following links.
 */
export type BrowserStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string; submit?: boolean }
  | { kind: 'select'; ref: string; values: string[] }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; ref?: string; direction?: 'up' | 'down'; amount?: number }
  | { kind: 'wait'; ms?: number; text?: string }
  | { kind: 'back' };

export type BrowserStepKind = BrowserStep['kind'];

export const BROWSER_STEP_KINDS: readonly BrowserStepKind[] = [
  'navigate',
  'click',
  'type',
  'select',
  'press',
  'scroll',
  'wait',
  'back',
];

/** Why a step was refused before anything ran: a malformed ref, or anything else. */
export type BrowserStepRefusal = { ok: false; type: 'bad_ref' | 'bad_request'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refOf(value: unknown, where: string): { ok: true; ref: string } | BrowserStepRefusal {
  if (!isBrowserRef(value)) {
    return {
      ok: false,
      type: 'bad_ref',
      message: `${where}: a ref looks like e12 — take it from the latest snapshot.`,
    };
  }
  return { ok: true, ref: value };
}

/**
 * Validate one step from the wire into a `BrowserStep`, or say exactly
 * what is wrong with it. Bounds every free-text field so a step can never
 * carry more than the corresponding single verb accepts.
 */
export function parseBrowserStep(
  value: unknown,
  where = 'step'
): { ok: true; step: BrowserStep } | BrowserStepRefusal {
  const refuse = (message: string): BrowserStepRefusal => ({
    ok: false,
    type: 'bad_request',
    message: `${where}: ${message}`,
  });
  if (!isRecord(value)) return refuse('a step is an object with a kind.');
  const kind = value.kind;
  switch (kind) {
    case 'navigate': {
      if (typeof value.url !== 'string' || !value.url) return refuse('navigate needs a url.');
      return { ok: true, step: { kind, url: value.url } };
    }
    case 'click': {
      const ref = refOf(value.ref, where);
      if (!ref.ok) return ref;
      return { ok: true, step: { kind, ref: ref.ref } };
    }
    case 'type': {
      const ref = refOf(value.ref, where);
      if (!ref.ok) return ref;
      if (typeof value.text !== 'string' || value.text.length > BROWSER_TYPE_MAX_CHARS) {
        return refuse(`text must be a string of at most ${BROWSER_TYPE_MAX_CHARS} characters.`);
      }
      if (value.submit !== undefined && typeof value.submit !== 'boolean') {
        return refuse('submit must be true or false.');
      }
      return {
        ok: true,
        step: { kind, ref: ref.ref, text: value.text, ...(value.submit ? { submit: true } : {}) },
      };
    }
    case 'select': {
      const ref = refOf(value.ref, where);
      if (!ref.ok) return ref;
      const values = value.values;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > BROWSER_SELECT_MAX_VALUES ||
        !values.every((option) => typeof option === 'string' && option.length <= 200)
      ) {
        return refuse(`values must be 1-${BROWSER_SELECT_MAX_VALUES} option labels or values.`);
      }
      // Cast: the every() above proved each entry is a string.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return { ok: true, step: { kind, ref: ref.ref, values: values as string[] } };
    }
    case 'press': {
      const key = value.key;
      if (
        typeof key !== 'string' ||
        key.length > BROWSER_KEY_MAX_LENGTH ||
        !BROWSER_KEY_PATTERN.test(key)
      ) {
        return refuse('key must be a key name like Enter, Escape, Tab, PageDown or Control+a.');
      }
      return { ok: true, step: { kind, key } };
    }
    case 'scroll': {
      const step: BrowserStep = { kind };
      if (value.ref !== undefined) {
        const ref = refOf(value.ref, where);
        if (!ref.ok) return ref;
        step.ref = ref.ref;
      }
      if (value.direction !== undefined) {
        if (value.direction !== 'up' && value.direction !== 'down') {
          return refuse('direction is "up" or "down".');
        }
        step.direction = value.direction;
      }
      if (value.amount !== undefined) {
        if (
          typeof value.amount !== 'number' ||
          !Number.isFinite(value.amount) ||
          value.amount <= 0 ||
          value.amount > BROWSER_SCROLL_MAX_PX
        ) {
          return refuse(`amount is a number of pixels between 1 and ${BROWSER_SCROLL_MAX_PX}.`);
        }
        step.amount = Math.floor(value.amount);
      }
      return { ok: true, step };
    }
    case 'wait': {
      const step: BrowserStep = { kind };
      if (value.ms !== undefined) {
        if (
          typeof value.ms !== 'number' ||
          !Number.isFinite(value.ms) ||
          value.ms <= 0 ||
          value.ms > BROWSER_WAIT_MAX_MS
        ) {
          return refuse(`ms is a number of milliseconds between 1 and ${BROWSER_WAIT_MAX_MS}.`);
        }
        step.ms = Math.floor(value.ms);
      }
      if (value.text !== undefined) {
        if (
          typeof value.text !== 'string' ||
          !value.text.trim() ||
          value.text.length > BROWSER_WAIT_TEXT_MAX_CHARS
        ) {
          return refuse(`text is 1-${BROWSER_WAIT_TEXT_MAX_CHARS} characters to wait for.`);
        }
        step.text = value.text;
      }
      if (step.ms === undefined && step.text === undefined) {
        return refuse('wait needs ms, text, or both.');
      }
      return { ok: true, step };
    }
    case 'back':
      return { ok: true, step: { kind } };
    default:
      return refuse(`unknown kind — one of ${BROWSER_STEP_KINDS.join(', ')}.`);
  }
}

/**
 * Validate a whole run: 1..BROWSER_RUN_MAX_STEPS steps, each well-formed,
 * with the explicit waits adding up to no more than the run's wait budget
 * (a run has to finish inside one tool call).
 */
export function parseBrowserSteps(
  value: unknown
): { ok: true; steps: BrowserStep[] } | BrowserStepRefusal {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, type: 'bad_request', message: 'steps must be a non-empty list.' };
  }
  if (value.length > BROWSER_RUN_MAX_STEPS) {
    return {
      ok: false,
      type: 'bad_request',
      message: `at most ${BROWSER_RUN_MAX_STEPS} steps per run — split the rest into another call.`,
    };
  }
  const steps: BrowserStep[] = [];
  let waiting = 0;
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseBrowserStep(value[index], `step ${index + 1}`);
    if (!parsed.ok) return parsed;
    if (parsed.step.kind === 'wait' && parsed.step.ms) waiting += parsed.step.ms;
    steps.push(parsed.step);
  }
  if (waiting > BROWSER_RUN_WAIT_BUDGET_MS) {
    return {
      ok: false,
      type: 'bad_request',
      message: `explicit waits add up to more than ${BROWSER_RUN_WAIT_BUDGET_MS}ms for one run.`,
    };
  }
  return { ok: true, steps };
}

/** What sandbox_browser_run answers: how far it got, where the page is, and what stopped it. */
export interface BrowserRunResult {
  /** Steps that finished, in order — equals steps.length on success. */
  completed: number;
  /** The page after the last step that ran; null only when it could not be read at all. */
  page: BrowserPageState | null;
  failed: { index: number; kind: BrowserStepKind; type: string; message: string } | null;
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
