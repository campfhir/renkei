/**
 * Shared look and DOM helpers for the preview cards.
 *
 * One small stylesheet, injected at runtime, keeps the three cards visually
 * one system. Colors are CSS custom properties so a host that provides style
 * variables (hostContext.styles.variables) restyles the card; the fallbacks
 * below cover hosts that provide none, in both themes. Theme selection is
 * `data-theme` stamped by the bridge, falling back to prefers-color-scheme.
 */

const STYLE = `
:root {
  --card-bg: #ffffff;
  --card-fg: #1a1d21;
  --card-muted: #6b7280;
  --card-border: #e2e5e9;
  --card-field-bg: #f6f7f8;
  --card-accent: #4c61e4;
  --card-accent-fg: #ffffff;
  --card-danger: #b42318;
  --card-warn: #b45309;
  --card-ok: #157347;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --card-bg: #1e2124;
    --card-fg: #e7e9ec;
    --card-muted: #9aa1ab;
    --card-border: #383d44;
    --card-field-bg: #26292e;
    --card-accent: #7286ff;
    --card-accent-fg: #101218;
    --card-ok: #4ade80;
    --card-danger: #f87171;
    --card-warn: #fbbf24;
  }
}
:root[data-theme='dark'] {
  --card-bg: #1e2124;
  --card-fg: #e7e9ec;
  --card-muted: #9aa1ab;
  --card-border: #383d44;
  --card-field-bg: #26292e;
  --card-accent: #7286ff;
  --card-accent-fg: #101218;
  --card-ok: #4ade80;
  --card-danger: #f87171;
  --card-warn: #fbbf24;
}
* { box-sizing: border-box; margin: 0; }
html, body { background: var(--card-bg); color: var(--card-fg); }
body {
  font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
  padding: 16px;
}
.card { display: flex; flex-direction: column; gap: 10px; }
.card-title { font-size: 15px; font-weight: 600; }
.card-subtitle { color: var(--card-muted); font-size: 12px; }
.field { display: flex; flex-direction: column; gap: 3px; }
.field-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--card-muted);
}
.field-value, .field input, .field textarea {
  font: inherit; color: inherit; width: 100%;
  background: var(--card-field-bg);
  border: 1px solid var(--card-border); border-radius: 6px;
  padding: 6px 9px;
}
.field-value { white-space: pre-wrap; overflow-wrap: anywhere; }
.field textarea { resize: vertical; min-height: 72px; }
.field input:focus, .field textarea:focus {
  outline: 2px solid var(--card-accent); outline-offset: -1px;
}
.actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.status { margin-right: auto; font-size: 13px; }
.status.error { color: var(--card-danger); }
.status.ok { color: var(--card-ok); }
button {
  font: inherit; font-weight: 600; cursor: pointer;
  border-radius: 6px; padding: 7px 14px;
  border: 1px solid var(--card-border);
  background: var(--card-bg); color: var(--card-fg);
}
button.primary {
  background: var(--card-accent); color: var(--card-accent-fg);
  border-color: var(--card-accent);
}
button:disabled { opacity: 0.5; cursor: default; }
.done { display: flex; align-items: center; gap: 12px; padding: 6px 0; }
.done-icon {
  width: 30px; height: 30px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 700; color: var(--card-bg);
}
.done-icon.sent { background: var(--card-ok); }
.done-icon.cancelled { background: var(--card-muted); }
.done-headline { font-weight: 600; }
.done-detail { color: var(--card-muted); font-size: 12px; overflow-wrap: anywhere; }
.rows { display: flex; flex-direction: column; }
.row {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 0; border-top: 1px solid var(--card-border);
}
.row:first-child { border-top: none; }
.row-title { font-weight: 600; overflow-wrap: anywhere; }
.row-meta { color: var(--card-muted); font-size: 12px; }
.row-body {
  font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 9em; overflow-y: auto;
}
.row-head { display: flex; align-items: center; gap: 8px; }
.row-head .row-title { flex: 1; }
.chip {
  font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px;
  flex: none; white-space: nowrap;
  background: color-mix(in srgb, currentColor 14%, transparent);
}
.chip.todo { color: var(--card-muted); }
.chip.progress { color: var(--card-accent); }
.chip.done { color: var(--card-ok); }
.chip.neutral { color: var(--card-muted); }
.chip.urgent { color: var(--card-danger); }
.chip.warn { color: var(--card-warn); }
.group-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 0 4px; margin-top: 4px;
}
.group-count { color: var(--card-muted); font-size: 12px; }
.avatar {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  position: relative; overflow: hidden;
  background: color-mix(in srgb, var(--card-accent) 18%, transparent);
  color: var(--card-accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; letter-spacing: 0.02em;
}
.avatar img {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
}
.row-people {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  font-size: 12px; color: var(--card-muted); margin-top: 2px;
}
.row-person { display: inline-flex; align-items: center; gap: 6px; }
.row-links { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 3px; }
button.link {
  font-size: 12px; font-weight: 600; padding: 3px 10px;
  border-radius: 999px; color: var(--card-accent);
  background: transparent; border: 1px solid var(--card-border);
}
button.link:hover { border-color: var(--card-accent); }
`;

export function injectStyle(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Label + read-only value block. */
export function readonlyField(label: string, value: string): HTMLElement {
  const field = el('div', 'field');
  field.append(el('div', 'field-label', label), el('div', 'field-value', value));
  return field;
}

/** Label + single-line input; returns both so callers can read the value back. */
export function inputField(
  label: string,
  value: string
): { field: HTMLElement; input: HTMLInputElement } {
  const field = el('div', 'field');
  const input = el('input');
  input.value = value;
  field.append(el('div', 'field-label', label), input);
  return { field, input };
}

/** Label + textarea; returns both so callers can read the value back. */
export function textField(
  label: string,
  value: string
): { field: HTMLElement; input: HTMLTextAreaElement } {
  const field = el('div', 'field');
  const input = el('textarea');
  input.value = value;
  field.append(el('div', 'field-label', label), input);
  return { field, input };
}

/**
 * The card's footer: a status line that doubles as the error surface, and the
 * cancel/confirm pair. `run` wires a button to an async action with every
 * button disabled while it runs — a second click mid-flight would double-send.
 */
export interface CardActions {
  actions: HTMLElement;
  setStatus: (text: string, kind?: 'ok' | 'error') => void;
  finish: (text: string, kind: 'ok' | 'error') => void;
  run: (button: HTMLButtonElement, action: () => Promise<void>) => void;
}

export function cardActions(buttons: HTMLButtonElement[]): CardActions {
  const actions = el('div', 'actions');
  const status = el('span', 'status');
  actions.append(status, ...buttons);
  const setStatus = (text: string, kind?: 'ok' | 'error') => {
    status.textContent = text;
    status.className = `status${kind ? ` ${kind}` : ''}`;
  };
  const setDisabled = (disabled: boolean) => {
    buttons.forEach((button) => {
      button.disabled = disabled;
    });
  };
  return {
    actions,
    setStatus,
    finish: (text, kind) => {
      setStatus(text, kind);
      setDisabled(true);
    },
    run: (button, action) => {
      button.addEventListener('click', () => {
        setDisabled(true);
        setStatus('Working…');
        action().catch((error: unknown) => {
          setStatus(error instanceof Error ? error.message : 'Something went wrong', 'error');
          setDisabled(false);
        });
      });
    },
  };
}

/**
 * The card's terminal state: once the user has sent or cancelled, the form
 * has no further job — it collapses to a compact receipt. `remember`/`recall`
 * keep that receipt across re-renders (a host may re-mount the iframe when
 * the conversation reopens, and re-showing an editable form for an email
 * that already went out invites a double send). localStorage may be
 * unavailable in an opaque-origin sandbox, so persistence is best-effort —
 * without it the card degrades to re-showing the form, never to re-sending.
 */
export interface DoneState {
  icon: 'sent' | 'cancelled';
  headline: string;
  detail?: string;
}

export function renderDone(root: HTMLElement, state: DoneState): void {
  root.textContent = '';
  const done = el('div', 'done');
  const icon = el('div', `done-icon ${state.icon}`, state.icon === 'sent' ? '✓' : '–');
  const text = el('div');
  text.append(el('div', 'done-headline', state.headline));
  if (state.detail) text.append(el('div', 'done-detail', state.detail));
  done.append(icon, text);
  root.append(done);
}

export function rememberDone(key: string, state: DoneState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // opaque-origin sandbox — the receipt lives only as long as the iframe
  }
}

export function recallDone(key: string): DoneState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const state = parsed as Record<string, unknown>;
    if (state.icon !== 'sent' && state.icon !== 'cancelled') return null;
    if (typeof state.headline !== 'string') return null;
    return {
      icon: state.icon,
      headline: state.headline,
      ...(typeof state.detail === 'string' ? { detail: state.detail } : {}),
    };
  } catch {
    return null;
  }
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** "a@x.com, b@y.com" back into a list; the inverse of how lists render. */
export function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
