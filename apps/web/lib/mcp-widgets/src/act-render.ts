/**
 * The drawings behind act-preview: one layout per kind of act (act-card.ts
 * says why they are separate). Each renderer is handed the body its tool's
 * builder produced and draws it the way the thing looks in the system it
 * lives in — a comment bubble, a status moving between two lozenges, a
 * file list with what happens to each file.
 *
 * Everything is drawn with textContent and DOM calls; nothing a tool put in
 * a card is ever parsed as HTML. The one innerHTML here is the icon set,
 * which is this file's own constant strings.
 */

import type {
  AccessBody,
  ActBody,
  Attendee,
  BranchBody,
  ChangeBody,
  CommentBody,
  CommitBody,
  DocumentBody,
  EventBody,
  FileOpBody,
  IconName,
  LinkBody,
  MailboxBody,
  Person,
  PipelineBody,
  Ref,
  Row,
  SprintBody,
  Tone,
  TransitionBody,
  VerdictBody,
  WorklogBody,
} from './act-card';
import { avatar, el, str } from './ui';

/* ------------------------------------------------------------------ */
/* Style                                                                */
/* ------------------------------------------------------------------ */

const STYLE = `
.a-head { display: flex; align-items: center; gap: 10px; }
.a-head-text { flex: 1; min-width: 0; }
.a-tile {
  width: 34px; height: 34px; border-radius: 9px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--tone) 14%, transparent); color: var(--tone);
}
.a-icon { display: inline-flex; width: 18px; height: 18px; flex: none; }
.a-icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.tone-positive { --tone: var(--card-ok); }
.tone-neutral { --tone: var(--card-accent); }
.tone-caution { --tone: var(--card-warn); }
.tone-danger { --tone: var(--card-danger); }
.a-verb {
  font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; flex: none;
  color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent);
}
.a-body { display: flex; flex-direction: column; gap: 10px; }
.a-ref {
  display: inline-flex; align-items: baseline; gap: 6px; max-width: 100%;
  padding: 3px 9px; border-radius: 6px;
  background: var(--card-field-bg); border: 1px solid var(--card-border);
}
.a-ref-label { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; flex: none; }
.a-ref-title { font-size: 13px; overflow-wrap: anywhere; }
.a-ref-context { font-size: 11px; color: var(--card-muted); flex: none; }
.a-refs { display: flex; flex-wrap: wrap; gap: 6px; }
.a-ref.is-struck .a-ref-label, .a-ref.is-struck .a-ref-title { text-decoration: line-through; opacity: 0.7; }
.a-caption { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--card-muted); }
.a-pill {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px;
  border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap;
  color: var(--tone, var(--card-muted)); background: color-mix(in srgb, var(--tone, var(--card-muted)) 14%, transparent);
}
.a-pill.is-struck { text-decoration: line-through; opacity: 0.7; }
.a-pill.is-muted { color: var(--card-muted); background: var(--card-field-bg); }
.a-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.a-bubble-row { display: flex; gap: 10px; align-items: flex-start; }
.a-bubble {
  flex: 1; min-width: 0; padding: 9px 12px; border-radius: 4px 12px 12px 12px;
  background: var(--card-field-bg); border: 1px solid var(--card-border);
  display: flex; flex-direction: column; gap: 6px;
}
.a-bubble.is-internal { border-style: dashed; border-color: var(--card-warn); }
.a-words { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; }
.a-words.is-clamped { max-height: 11em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.a-more { align-self: flex-start; }
.a-words-edit { width: 100%; font: inherit; font-size: 16px; color: inherit; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 7px 9px; resize: vertical; }
textarea.a-words-edit { min-height: 84px; }
.a-words-edit:focus { outline: 2px solid var(--card-accent); outline-offset: -1px; }
.a-anchor { border: 1px solid var(--card-border); border-left: 3px solid var(--card-accent); border-radius: 6px; padding: 6px 10px; background: var(--card-field-bg); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.a-anchor-file { color: var(--card-muted); margin-bottom: 2px; }
.a-flow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.a-flow .a-icon { color: var(--card-muted); }
.a-lozenge { padding: 3px 11px; border-radius: 5px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; background: var(--card-field-bg); border: 1px solid var(--card-border); }
.a-lozenge.is-to { color: var(--tone, var(--card-accent)); border-color: var(--tone, var(--card-accent)); background: color-mix(in srgb, var(--tone, var(--card-accent)) 12%, transparent); }
.a-code { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--card-field-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 7px 10px; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 10em; overflow-y: auto; }
.a-big { font-size: 28px; font-weight: 700; letter-spacing: -0.01em; }
.a-meta { color: var(--card-muted); font-size: 12px; }
.a-trio { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: center; }
.a-trio .a-ref { justify-self: stretch; }
.a-relation { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px; color: var(--card-muted); }
.a-relation .a-pill { color: var(--card-accent); }
@media (max-width: 440px) {
  .a-trio { grid-template-columns: minmax(0, 1fr); }
  .a-relation { flex-direction: row; justify-content: flex-start; }
  .a-relation .a-icon { transform: rotate(90deg); }
}
.a-people { display: flex; flex-direction: column; gap: 6px; }
.a-person { display: flex; align-items: center; gap: 9px; }
.a-person-name { font-weight: 600; overflow-wrap: anywhere; }
.a-person-detail { font-size: 12px; color: var(--card-muted); overflow-wrap: anywhere; }
.a-table { display: flex; flex-direction: column; border: 1px solid var(--card-border); border-radius: 8px; overflow: hidden; }
.a-table-row { display: grid; grid-template-columns: minmax(84px, 28%) minmax(0, 1fr); gap: 10px; padding: 7px 11px; border-top: 1px solid var(--card-border); font-size: 13px; }
.a-table-row:first-child { border-top: none; }
.a-table-label { color: var(--card-muted); font-size: 12px; font-weight: 600; }
.a-from { color: var(--card-muted); text-decoration: line-through; margin-right: 6px; overflow-wrap: anywhere; }
.a-to { font-weight: 600; overflow-wrap: anywhere; }
.a-add { color: var(--card-ok); }
.a-remove { color: var(--card-danger); text-decoration: line-through; }
.a-note { font-size: 12.5px; color: var(--card-muted); display: flex; gap: 8px; align-items: flex-start; }
.a-note .a-icon { width: 15px; height: 15px; margin-top: 1px; }
.a-note.is-warn { color: var(--card-warn); }
.a-note.is-danger { color: var(--card-danger); }
.a-banner { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px; color: var(--tone); background: color-mix(in srgb, var(--tone) 11%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent); }
.a-banner .a-icon { width: 26px; height: 26px; }
.a-banner-title { font-size: 14px; font-weight: 600; }
.a-files { display: flex; flex-direction: column; border: 1px solid var(--card-border); border-radius: 8px; overflow: hidden; max-height: 14em; overflow-y: auto; }
.a-file { display: flex; align-items: center; gap: 9px; padding: 5px 10px; border-top: 1px solid var(--card-border); font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.a-file:first-child { border-top: none; }
.a-file-path { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.a-file.is-delete .a-file-path { text-decoration: line-through; color: var(--card-muted); }
.a-badge { width: 18px; height: 18px; border-radius: 4px; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--tone); background: color-mix(in srgb, var(--tone) 16%, transparent); }
.a-datetile { width: 52px; flex: none; border: 1px solid var(--card-border); border-radius: 9px; overflow: hidden; text-align: center; background: var(--card-field-bg); }
.a-datetile-month { background: var(--card-danger); color: #fff; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 0; }
.a-datetile-day { font-size: 22px; font-weight: 700; line-height: 1.25; }
.a-event { display: flex; gap: 12px; align-items: flex-start; }
.a-event-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.a-event-title { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.a-doc-title { font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
.a-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 12px; color: var(--card-muted); }
.a-crumbs span + span::before { content: '›'; margin-right: 4px; }
.a-fileop { display: flex; flex-direction: column; gap: 8px; }
.a-item { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border: 1px solid var(--card-border); border-radius: 8px; background: var(--card-field-bg); }
.a-item .a-icon { color: var(--card-muted); }
.a-item-name { font-weight: 600; overflow-wrap: anywhere; }
.a-item-path { font-size: 11.5px; color: var(--card-muted); overflow-wrap: anywhere; }
.a-item.is-struck .a-item-name { text-decoration: line-through; }
.a-arrow-row { display: flex; justify-content: center; color: var(--card-muted); }
.a-sprint-card { border: 1px solid var(--card-border); border-radius: 10px; padding: 10px 12px; background: var(--card-field-bg); display: flex; flex-direction: column; gap: 5px; }
.a-sprint-name { font-weight: 700; font-size: 15px; }
button.primary.is-danger { background: var(--card-danger); border-color: var(--card-danger); color: #fff; }
`;

let styled = false;
export function injectActStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/* Pieces                                                               */
/* ------------------------------------------------------------------ */

const ICONS: Record<IconName, string> = {
  comment: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-6 7-6s7 2.1 7 6"/>',
  users:
    '<circle cx="9" cy="8.5" r="3"/><path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5"/><path d="M16 5.8a3 3 0 0 1 0 5.4M18 14.3c2 .6 3 2.1 3 4.7"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  branch:
    '<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 7.5v9M17 11c0 3-3 3.5-10 5.5"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  calendar:
    '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  flag: '<path d="M6 21V4M6 5h11l-2.5 4L17 13H6"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10.5 11v6M13.5 11v6"/>',
  tag: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.4M12 18.1v2.4M3.5 12h2.4M18.1 12h2.4M6 6l1.7 1.7M16.3 16.3L18 18M18 6l-1.7 1.7M7.7 16.3L6 18"/>',
  sprint: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  merge:
    '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="14" r="2"/><path d="M6.5 7.5v9M6.5 8c0 4 11 1.5 11 4"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
};

export function icon(name: IconName): HTMLElement {
  const holder = el('span', 'a-icon');
  holder.setAttribute('aria-hidden', 'true');
  // Constant strings from ICONS above; no card data reaches this.
  holder.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return holder;
}

export function toneClass(tone: Tone | undefined): string {
  return `tone-${tone ?? 'neutral'}`;
}

function ref(value: Ref | undefined, struck = false): HTMLElement {
  const chip = el('span', `a-ref${struck ? ' is-struck' : ''}`);
  chip.append(el('span', 'a-ref-label', str(value?.label)));
  if (str(value?.title)) chip.append(el('span', 'a-ref-title', str(value?.title)));
  if (str(value?.context)) chip.append(el('span', 'a-ref-context', str(value?.context)));
  return chip;
}

function pill(text: string, className = ''): HTMLElement {
  return el('span', `a-pill ${className}`.trim(), text);
}

function pills(values: string[], className = ''): HTMLElement {
  const row = el('div', 'a-pills');
  for (const value of values) row.append(pill(value, className));
  return row;
}

function caption(text: string): HTMLElement {
  return el('div', 'a-caption', text);
}

function note(
  text: string,
  kind: '' | 'warn' | 'danger' = '',
  glyph: IconName = 'bell'
): HTMLElement {
  const line = el('div', `a-note${kind ? ` is-${kind}` : ''}`);
  line.append(icon(glyph), el('span', undefined, text));
  return line;
}

function person(value: Person): HTMLElement {
  const row = el('div', 'a-person');
  const text = el('div');
  text.append(el('div', 'a-person-name', str(value.name)));
  if (str(value.detail)) text.append(el('div', 'a-person-detail', str(value.detail)));
  row.append(avatar(str(value.name) || '?'), text);
  if (value.kind === 'group') row.append(pill('Group', 'is-muted'));
  return row;
}

function tableRow(label: string, ...content: Node[]): HTMLElement {
  const row = el('div', 'a-table-row');
  const value = el('div');
  value.append(...content);
  row.append(el('div', 'a-table-label', label), value);
  return row;
}

/** "2026-10-21T14:00:00" → "Wed, 21 Oct · 14:00", as written, with no zone conversion. */
const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
function whenParts(text: string): { date: Date; hasTime: boolean } | null {
  const match = WHEN.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  return {
    date: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0))),
    hasTime: h !== undefined,
  };
}
export function formatWhen(text: string): string {
  const parts = whenParts(text);
  if (!parts) return text;
  const day = parts.date.toLocaleDateString('en', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  if (!parts.hasTime) return day;
  const time = parts.date.toLocaleTimeString('en', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${day} · ${time}`;
}

/* ------------------------------------------------------------------ */
/* The context a renderer draws in                                      */
/* ------------------------------------------------------------------ */

export interface RenderContext {
  /**
   * Words the person wrote or the model drafted. Read-only unless the card
   * lists `key` as editable, in which case it is a text box whose value
   * replaces that argument on confirm.
   */
  words(key: string | undefined, text: string | undefined, label?: string): HTMLElement | null;
}

const CLAMP = 700;

export function readOnlyWords(text: string): HTMLElement {
  const wrap = el('div');
  const words = el('div', 'a-words', text);
  wrap.append(words);
  if (text.length > CLAMP) {
    words.classList.add('is-clamped');
    const more = el('button', 'link a-more', 'Show all');
    more.type = 'button';
    more.addEventListener('click', () => {
      const open = words.classList.toggle('is-clamped');
      more.textContent = open ? 'Show all' : 'Show less';
    });
    wrap.append(more);
  }
  return wrap;
}

function wordsBlock(
  ctx: RenderContext,
  key: string | undefined,
  text: string | undefined,
  label?: string
) {
  return ctx.words(key, text, label);
}

/* ------------------------------------------------------------------ */
/* Renderers                                                            */
/* ------------------------------------------------------------------ */

const COMMENT_HEAD: Record<CommentBody['mode'], string> = {
  add: 'You will post',
  note: 'You will save',
  task: 'You will add this task',
  edit: 'The comment will read',
  delete: 'This comment will be removed',
  resolve: 'This thread will be marked resolved',
  reopen: 'This thread will be reopened',
};

function renderComment(body: CommentBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  const refs = el('div', 'a-refs');
  refs.append(ref(body.on));
  root.append(refs);
  if (body.anchor && (body.anchor.file || body.anchor.text)) {
    const anchor = el('div', 'a-anchor');
    const where = [str(body.anchor.file), body.anchor.line ? `line ${body.anchor.line}` : '']
      .filter(Boolean)
      .join(' · ');
    if (where) anchor.append(el('div', 'a-anchor-file', where));
    if (str(body.anchor.text)) anchor.append(el('div', undefined, str(body.anchor.text)));
    root.append(anchor);
  }
  root.append(caption(COMMENT_HEAD[body.mode]));
  if (body.mode === 'delete' || body.mode === 'resolve' || body.mode === 'reopen') {
    const line = el('div', 'a-flow');
    line.append(
      icon(body.mode === 'delete' ? 'trash' : 'check'),
      el('span', undefined, body.commentLabel ? `Comment ${body.commentLabel}` : 'The comment')
    );
    if (body.mode !== 'delete') {
      line.append(
        icon('arrow'),
        pill(body.mode === 'resolve' ? 'Resolved' : 'Open', 'tone-positive')
      );
    }
    root.append(line);
    return root;
  }
  const bubble = el(
    'div',
    `a-bubble${body.badges?.includes('Internal note') ? ' is-internal' : ''}`
  );
  if (body.badges && body.badges.length > 0) bubble.append(pills(body.badges, 'is-muted'));
  const words = wordsBlock(ctx, body.bodyKey, body.body, 'Comment');
  if (words) bubble.append(words);
  const row = el('div', 'a-bubble-row');
  row.append(avatar('You'), bubble);
  root.append(row);
  return root;
}

const VERDICTS: Record<
  VerdictBody['verdict'],
  { icon: IconName; title: string; tone: Tone; line: string }
> = {
  approve: {
    icon: 'check',
    title: 'Approve',
    tone: 'positive',
    line: 'You are signing off on this pull request.',
  },
  changes: {
    icon: 'flag',
    title: 'Request changes',
    tone: 'caution',
    line: 'The author will be told this cannot merge as it is.',
  },
  decline: {
    icon: 'cross',
    title: 'Decline',
    tone: 'danger',
    line: 'The pull request is closed without merging.',
  },
  close: {
    icon: 'cross',
    title: 'Close without merging',
    tone: 'danger',
    line: 'The pull request is closed; the branch is left alone.',
  },
  unapprove: {
    icon: 'cross',
    title: 'Withdraw your approval',
    tone: 'caution',
    line: 'Your earlier approval no longer counts.',
  },
  unchange: {
    icon: 'check',
    title: 'Withdraw your change request',
    tone: 'neutral',
    line: 'Your earlier request for changes no longer blocks it.',
  },
};

function renderVerdict(body: VerdictBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  const verdict = VERDICTS[body.verdict];
  root.append(ref(body.pullRequest));
  const banner = el('div', `a-banner ${toneClass(verdict.tone)}`);
  // The chip above already says the verb; the banner says what it means.
  const text = el('div');
  text.append(el('div', 'a-banner-title', verdict.line));
  banner.append(icon(verdict.icon), text);
  root.append(banner);
  const words = wordsBlock(ctx, body.bodyKey, body.body, 'Comment with your review');
  if (words) root.append(caption('With your comment'), words);
  return root;
}

function renderTransition(body: TransitionBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  if (body.subject) root.append(ref(body.subject));
  if (body.query) {
    root.append(caption('Every item matching'), el('div', 'a-code', body.query));
  }
  root.append(caption(body.field));
  const flow = el('div', 'a-flow');
  if (body.from) flow.append(el('span', 'a-lozenge', body.from), icon('arrow'));
  flow.append(el('span', 'a-lozenge is-to', body.to));
  root.append(flow);
  const words = wordsBlock(ctx, body.noteKey, body.note, 'Comment');
  if (words) root.append(caption('With a comment'), words);
  return root;
}

function renderWorklog(body: WorklogBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  root.append(ref(body.on));
  if (body.mode === 'delete') {
    const line = el('div', 'a-flow');
    line.append(
      icon('trash'),
      el(
        'span',
        undefined,
        `${body.worklogLabel ? `The worklog (${body.worklogLabel})` : 'The worklog'} will be removed and its time taken back off the issue.`
      )
    );
    root.append(line);
    return root;
  }
  const time = el('div', 'a-flow');
  time.append(icon('clock'), el('span', 'a-big', str(body.duration)));
  root.append(time);
  root.append(
    el('div', 'a-meta', body.started ? `Started ${formatWhen(body.started)}` : 'Started now')
  );
  const words = wordsBlock(ctx, body.bodyKey, body.body, 'What you worked on');
  if (words) root.append(caption('What you worked on'), words);
  return root;
}

function renderLink(body: LinkBody): HTMLElement {
  const root = el('div', 'a-body');
  if (body.mode === 'delete' && !body.from) {
    const line = el('div', 'a-flow');
    line.append(
      icon('trash'),
      el(
        'span',
        undefined,
        `${body.linkLabel ? `The link (${body.linkLabel})` : 'The link'} will be removed from both issues.`
      )
    );
    root.append(line);
    return root;
  }
  const trio = el('div', 'a-trio');
  const middle = el('div', 'a-relation');
  middle.append(pill(body.relation), icon('arrow'));
  const target = body.to
    ? ref(body.to, body.mode === 'delete')
    : (() => {
        const chip = el('span', 'a-ref');
        chip.append(el('span', 'a-ref-title', str(body.url?.title)));
        chip.append(el('span', 'a-ref-context', hostOf(str(body.url?.href))));
        return chip;
      })();
  trio.append(ref(body.from, body.mode === 'delete'), middle, target);
  root.append(trio);
  if (body.mode === 'delete') {
    root.append(note('The link is removed from both issues.', 'danger', 'trash'));
  } else if (body.url) {
    root.append(el('div', 'a-meta', str(body.url.href)));
  }
  return root;
}

function hostOf(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return '';
  }
}

const ACCESS_VERB: Record<AccessBody['mode'], string> = {
  grant: 'Will be given access',
  revoke: 'Will lose access',
  invite: 'Will be invited',
  add: 'Will be added',
  remove: 'Will be removed',
  watch: 'You will start watching',
  unwatch: 'You will stop watching',
  share: 'Will be sent a share',
};

function renderAccess(body: AccessBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  root.append(caption(ACCESS_VERB[body.mode]));
  if (body.who.length > 0) {
    const people = el('div', 'a-people');
    for (const who of body.who) people.append(person(who));
    root.append(people);
  }
  const to = el('div', 'a-flow');
  if (body.level)
    to.append(
      pill(
        body.level,
        toneClass(body.mode === 'revoke' || body.mode === 'remove' ? 'danger' : 'neutral')
      )
    );
  to.append(el('span', 'a-meta', 'on'), ref(body.on));
  root.append(to);
  if (body.details && body.details.length > 0) {
    const table = el('div', 'a-table');
    for (const detail of body.details)
      table.append(tableRow(detail.label, document.createTextNode(detail.value)));
    root.append(table);
  }
  const words = wordsBlock(ctx, body.bodyKey, body.body, 'Message');
  if (words) root.append(caption('Message to them'), words);
  return root;
}

function renderDocument(body: DocumentBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  const top = el('div', 'a-flow');
  top.append(pill(body.type, 'is-muted'));
  if (body.status)
    top.append(
      pill(body.status, toneClass(body.status.toLowerCase() === 'draft' ? 'caution' : 'positive'))
    );
  root.append(top);
  if (body.location && body.location.length > 0) {
    const crumbs = el('div', 'a-crumbs');
    for (const part of body.location) crumbs.append(el('span', undefined, part));
    root.append(crumbs);
  }
  if (body.title !== undefined) {
    const title = wordsBlock(ctx, body.titleKey, body.title, 'Title');
    if (title) {
      if (body.titleKey) root.append(caption('Title'));
      else title.classList.add('a-doc-title');
      root.append(title);
    }
  }
  if (body.mode === 'delete') {
    root.append(note('It moves out of view for everyone who can see it.', 'danger', 'trash'));
  }
  if (body.body !== undefined) {
    root.append(
      caption(body.bodyLabel ?? (body.mode === 'append' ? 'Will be added at the end' : 'Content'))
    );
    const words = wordsBlock(ctx, body.bodyKey, body.body, body.bodyLabel ?? 'Content');
    if (words) root.append(words);
  }
  if (body.versionNote) root.append(el('div', 'a-meta', `Version note: ${body.versionNote}`));
  if (body.unchanged) root.append(el('div', 'a-meta', body.unchanged));
  return root;
}

function fileItem(item: FileOpBody['items'][number], struck: boolean): HTMLElement {
  const row = el('div', `a-item${struck ? ' is-struck' : ''}`);
  row.append(
    icon(item.type === 'folder' ? 'folder' : item.type === 'attachment' ? 'upload' : 'doc')
  );
  const text = el('div');
  text.append(el('div', 'a-item-name', item.name));
  if (item.path) text.append(el('div', 'a-item-path', item.path));
  row.append(text);
  return row;
}

function renderFileOp(body: FileOpBody): HTMLElement {
  const root = el('div', 'a-body');
  const wrap = el('div', 'a-fileop');
  const items = body.items.length > 0 ? body.items : [];
  for (const item of items) wrap.append(fileItem(item, body.mode === 'delete'));
  if (body.mode === 'move' || body.mode === 'copy' || body.mode === 'rename') {
    const arrow = el('div', 'a-arrow-row');
    arrow.append(icon('arrow'));
    wrap.append(arrow);
    const target = el('div', 'a-item');
    target.append(icon(body.mode === 'rename' ? 'doc' : 'folder'));
    const text = el('div');
    text.append(
      el(
        'div',
        'a-item-name',
        body.mode === 'rename'
          ? str(body.to?.name)
          : str(body.to?.path) || str(body.to?.name) || 'Same folder'
      )
    );
    if (body.mode !== 'rename' && str(body.to?.name))
      text.append(el('div', 'a-item-path', `as ${str(body.to?.name)}`));
    target.append(text);
    wrap.append(target);
  } else if (body.mode === 'create' && body.to?.path) {
    wrap.append(el('div', 'a-meta', `in ${body.to.path}`));
  }
  root.append(wrap);
  if (body.details && body.details.length > 0) {
    const table = el('div', 'a-table');
    for (const detail of body.details)
      table.append(tableRow(detail.label, document.createTextNode(detail.value)));
    root.append(table);
  }
  if (body.note)
    root.append(
      note(
        body.note,
        body.mode === 'delete' ? 'danger' : '',
        body.mode === 'delete' ? 'trash' : 'bell'
      )
    );
  return root;
}

function rowNode(row: Row): HTMLElement {
  const content: Node[] = [];
  if (row.from !== undefined || row.value !== undefined) {
    const span = el('div', row.block ? 'a-code' : undefined);
    if (row.from !== undefined) span.append(el('span', 'a-from', row.from || '(empty)'));
    if (row.value !== undefined) span.append(el('span', 'a-to', row.value || '(empty)'));
    content.push(span);
  }
  if (row.add && row.add.length > 0) {
    const chips = pills(
      row.add.map((value) => `+ ${value}`),
      'tone-positive'
    );
    content.push(chips);
  }
  if (row.remove && row.remove.length > 0) {
    content.push(
      pills(
        row.remove.map((value) => `− ${value}`),
        'tone-danger'
      )
    );
  }
  return tableRow(row.label, ...content);
}

function renderChange(body: ChangeBody): HTMLElement {
  const root = el('div', 'a-body');
  root.append(ref(body.subject));
  if (body.rows.length > 0) {
    const table = el('div', 'a-table');
    for (const row of body.rows) table.append(rowNode(row));
    root.append(table);
  }
  for (const text of body.notes ?? []) root.append(note(text));
  return root;
}

const FILE_BADGE: Record<string, { letter: string; tone: Tone }> = {
  add: { letter: 'A', tone: 'positive' },
  modify: { letter: 'M', tone: 'caution' },
  delete: { letter: 'D', tone: 'danger' },
};

function renderCommit(body: CommitBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  const where = el('div', 'a-flow');
  where.append(icon('branch'), pill(body.branch, 'is-muted'), el('span', 'a-meta', body.repo));
  root.append(where);
  root.append(caption('Commit message'));
  const message = wordsBlock(ctx, body.messageKey, body.message, 'Commit message');
  if (message) root.append(message);
  root.append(
    caption(
      `${body.files.length + (body.omitted ?? 0)} file${body.files.length + (body.omitted ?? 0) === 1 ? '' : 's'}`
    )
  );
  const list = el('div', 'a-files');
  for (const file of body.files) {
    const badge = FILE_BADGE[file.status] ?? FILE_BADGE.modify!;
    const row = el('div', `a-file${file.status === 'delete' ? ' is-delete' : ''}`);
    const mark = el('span', `a-badge ${toneClass(badge.tone)}`, badge.letter);
    row.append(mark, el('span', 'a-file-path', file.path));
    if (file.lines !== undefined) row.append(el('span', 'a-meta', `${file.lines} lines`));
    list.append(row);
  }
  if (body.omitted) list.append(el('div', 'a-file', `…and ${body.omitted} more`));
  root.append(list);
  const peek = body.files.length === 1 ? body.files[0]?.peek : undefined;
  if (peek) root.append(el('div', 'a-code', peek));
  return root;
}

function renderBranch(body: BranchBody): HTMLElement {
  const root = el('div', 'a-body');
  root.append(el('div', 'a-meta', body.repo));
  const flow = el('div', 'a-flow');
  flow.append(icon('branch'));
  if (body.mode === 'create') {
    if (body.base) flow.append(pill(body.base, 'is-muted'), icon('arrow'));
    flow.append(pill(body.name, toneClass('positive')));
    root.append(flow);
    root.append(
      note(body.base ? `Starts from ${body.base}.` : 'Starts from the repository’s default branch.')
    );
  } else {
    flow.append(pill(body.name, 'is-struck tone-danger'));
    root.append(flow);
    root.append(note('Commits only on this branch become hard to find.', 'danger', 'trash'));
  }
  return root;
}

function renderPipeline(body: PipelineBody): HTMLElement {
  const root = el('div', 'a-body');
  root.append(el('div', 'a-meta', body.repo));
  const flow = el('div', 'a-flow');
  flow.append(icon('stop'), el('span', 'a-ref-label', body.run));
  if (body.ref) flow.append(pill(body.ref, 'is-muted'));
  root.append(flow);
  root.append(
    note(
      body.mode === 'stop'
        ? 'Steps already finished keep their results; the rest do not run.'
        : 'The run is cancelled where it stands.',
      'warn',
      'stop'
    )
  );
  return root;
}

function renderSprint(body: SprintBody): HTMLElement {
  const root = el('div', 'a-body');
  const sprint = body.sprint;
  if (sprint && (sprint.name || sprint.id)) {
    // The id is the confirm call's handle, never wording for a person.
    const card = el('div', 'a-sprint-card');
    card.append(el('div', 'a-sprint-name', sprint.name || 'The sprint'));
    const dates = [
      sprint.start ? formatWhen(sprint.start) : '',
      sprint.end ? formatWhen(sprint.end) : '',
    ]
      .filter(Boolean)
      .join(' → ');
    if (dates) card.append(el('div', 'a-meta', dates));
    if (sprint.board) card.append(el('div', 'a-meta', `Board ${sprint.board}`));
    if (sprint.goal) card.append(el('div', undefined, `Goal: ${sprint.goal}`));
    root.append(card);
  }
  if (body.issues && body.issues.length > 0) {
    root.append(
      caption(
        body.mode === 'remove'
          ? 'Back to the backlog'
          : body.mode === 'move'
            ? body.sprint
              ? 'Moving into the sprint'
              : 'Moving out of its sprints'
            : 'Issues'
      )
    );
    const refs = el('div', 'a-refs');
    for (const key of body.issues) refs.append(ref({ label: key }));
    root.append(refs);
  }
  if (body.mode === 'complete') {
    root.append(note('Issues not done are moved out of the sprint.', 'warn', 'sprint'));
  }
  return root;
}

function attendeeChip(attendee: Attendee): HTMLElement {
  const chip = pill(
    attendee.optional ? `${attendee.name} (optional)` : attendee.name,
    attendee.removed ? 'is-struck tone-danger' : 'is-muted'
  );
  return chip;
}

function renderEvent(body: EventBody, ctx: RenderContext): HTMLElement {
  const root = el('div', 'a-body');
  const start = body.start ? whenParts(body.start) : null;
  const top = el('div', 'a-event');
  if (start) {
    const tile = el('div', 'a-datetile');
    tile.append(
      el(
        'div',
        'a-datetile-month',
        start.date.toLocaleDateString('en', { month: 'short', timeZone: 'UTC' })
      ),
      el('div', 'a-datetile-day', String(start.date.getUTCDate()))
    );
    top.append(tile);
  }
  const text = el('div', 'a-event-text');
  if (body.subject !== undefined)
    text.append(el('div', 'a-event-title', body.subject || '(no title)'));
  if (body.start) {
    const end = body.end ? whenParts(body.end) : null;
    const startText = formatWhen(body.start);
    const endText =
      end && start && end.hasTime && end.date.toDateString() === start.date.toDateString()
        ? end.date.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
        : body.end
          ? formatWhen(body.end)
          : '';
    text.append(el('div', undefined, endText ? `${startText} – ${endText}` : startText));
    if (body.timezone) text.append(el('div', 'a-meta', body.timezone));
  }
  if (body.where) text.append(el('div', 'a-meta', body.where));
  if (body.recurrence) text.append(el('div', 'a-meta', `Repeats ${body.recurrence}`));
  top.append(text);
  root.append(top);
  const badges: string[] = [];
  if (body.online) badges.push('Online meeting');
  if (body.scope) badges.push(body.scope);
  if (badges.length > 0) root.append(pills(badges, 'is-muted'));
  if (body.mode === 'respond' && body.response) {
    const tone: Tone =
      body.response === 'accept' ? 'positive' : body.response === 'decline' ? 'danger' : 'caution';
    const banner = el('div', `a-banner ${toneClass(tone)}`);
    banner.append(
      icon(body.response === 'decline' ? 'cross' : 'check'),
      el(
        'div',
        'a-banner-title',
        body.response === 'accept' ? 'Accept' : body.response === 'decline' ? 'Decline' : 'Maybe'
      )
    );
    root.append(banner);
  }
  if (body.attendees && body.attendees.length > 0) {
    root.append(caption(body.mode === 'update' ? 'Attendee changes' : 'Attendees'));
    const chips = el('div', 'a-pills');
    for (const attendee of body.attendees) chips.append(attendeeChip(attendee));
    root.append(chips);
  }
  const words = wordsBlock(
    ctx,
    body.bodyKey,
    body.body,
    body.mode === 'respond' ? 'Message to the organizer' : 'Description'
  );
  if (words) root.append(words);
  if (body.mode === 'delete') {
    root.append(note('Everyone invited is told it is cancelled.', 'danger', 'trash'));
  }
  if (body.note) root.append(el('div', 'a-meta', body.note));
  return root;
}

function renderMailbox(body: MailboxBody): HTMLElement {
  const root = el('div', 'a-body');
  const headline: Record<MailboxBody['mode'], string> = {
    read: 'Mark as read',
    unread: 'Mark as unread',
    flag: 'Flag for follow-up',
    unflag: 'Clear the flag',
    complete: 'Mark the flag complete',
    categorize: 'Change categories',
    move: 'Move to a folder',
    archive: 'Archive',
    'folder-create': 'Create a mail folder',
    'folder-rename': 'Rename a mail folder',
    'folder-delete': 'Delete a mail folder',
    bulk: 'Apply to every matching message',
  };
  const line = el('div', 'a-flow');
  line.append(icon('mail'), el('span', 'a-to', headline[body.mode]));
  root.append(line);
  if (body.messages) root.append(el('div', 'a-meta', body.messages));
  if (body.filters && body.filters.length > 0) {
    const table = el('div', 'a-table');
    for (const filter of body.filters)
      table.append(tableRow(filter.label, document.createTextNode(filter.value)));
    root.append(table);
  }
  if (body.folder || body.to) {
    const flow = el('div', 'a-flow');
    if (body.folder)
      flow.append(
        icon('folder'),
        pill(body.folder, body.mode === 'folder-delete' ? 'is-struck tone-danger' : 'is-muted')
      );
    if (body.folder && body.to) flow.append(icon('arrow'));
    if (body.to) flow.append(icon('folder'), pill(body.to, toneClass('positive')));
    root.append(flow);
  }
  if (body.categories) {
    if (body.categories.replace && body.categories.replace.length > 0) {
      root.append(caption('Categories become'), pills(body.categories.replace, 'tone-neutral'));
    }
    if (body.categories.add && body.categories.add.length > 0) {
      root.append(
        caption('Add'),
        pills(
          body.categories.add.map((value) => `+ ${value}`),
          'tone-positive'
        )
      );
    }
    if (body.categories.remove && body.categories.remove.length > 0) {
      root.append(
        caption('Remove'),
        pills(
          body.categories.remove.map((value) => `− ${value}`),
          'tone-danger'
        )
      );
    }
  }
  if (body.mode === 'folder-delete') {
    root.append(note('The folder and the mail in it go to Deleted Items.', 'danger', 'trash'));
  }
  return root;
}

/** Draws one body. An unknown kind draws nothing — the shell shows the headline and buttons. */
export function renderBody(body: ActBody, ctx: RenderContext): HTMLElement | null {
  switch (body.kind) {
    case 'comment':
      return renderComment(body, ctx);
    case 'verdict':
      return renderVerdict(body, ctx);
    case 'transition':
      return renderTransition(body, ctx);
    case 'worklog':
      return renderWorklog(body, ctx);
    case 'link':
      return renderLink(body);
    case 'access':
      return renderAccess(body, ctx);
    case 'document':
      return renderDocument(body, ctx);
    case 'fileop':
      return renderFileOp(body);
    case 'change':
      return renderChange(body);
    case 'commit':
      return renderCommit(body, ctx);
    case 'branch':
      return renderBranch(body);
    case 'pipeline':
      return renderPipeline(body);
    case 'sprint':
      return renderSprint(body);
    case 'event':
      return renderEvent(body, ctx);
    case 'mailbox':
      return renderMailbox(body);
    default:
      return null;
  }
}
