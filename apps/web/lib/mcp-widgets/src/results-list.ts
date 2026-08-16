/**
 * Read-results card (search results, request queues, comment threads).
 *
 * The read-side sibling of the issue-preview card, and generic the same way:
 * a `*_preview` read tool ships everything in structuredContent —
 *
 *   { kind: 'results', title, subtitle?,
 *     links?: [{ label, url }],                    // card-level (the issue)
 *     groups?: [{ label, chip?, rows }],           // e.g. grouped by status
 *     rows?: [Row],                                // flat, when no grouping
 *     footer? }
 *
 *   Row: { title, meta?, body?,
 *          avatarUrl?,                             // leading avatar (comments)
 *          chip?: { label, tone },                 // status pill on the row
 *          people?: [{ name, avatarUrl?, role? }], // assignee / reporter line
 *          links?: [{ label, url }] }              // Agent view / Portal / …
 *
 * — and one card renders Jira issues, JSM requests, and comment threads
 * alike. Chip tones are semantic ('todo' | 'progress' | 'done' | 'neutral'),
 * mapped server-side from Jira's status categories so colors stay right in
 * both themes. Avatars render initials first and layer the image on top —
 * an avatar host the CSP or network refuses degrades to initials, never to
 * a broken-image glyph. Nothing here mutates; links open via ui/open-link.
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import { el, injectStyle, str } from './ui';

interface Link {
  label: string;
  url: string;
}

const CHIP_TONES = new Set(['todo', 'progress', 'done', 'neutral', 'urgent', 'warn']);

function asRecord(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function linksOf(value: unknown): Link[] {
  return Array.isArray(value)
    ? value
        .map((entry) => {
          const record = asRecord(entry);
          return { label: str(record.label), url: str(record.url) };
        })
        .filter((link) => link.label && /^https:\/\//.test(link.url))
    : [];
}

function linkButtons(bridge: WidgetBridge, links: Link[]): HTMLElement {
  const container = el('div', 'row-links');
  for (const link of links) {
    const button = el('button', 'link', link.label);
    button.addEventListener('click', () => bridge.openLink(link.url));
    container.append(button);
  }
  return container;
}

function chipOf(value: unknown): HTMLElement | null {
  const record = asRecord(value);
  const label = str(record.label);
  if (!label) return null;
  const tone = CHIP_TONES.has(str(record.tone)) ? str(record.tone) : 'neutral';
  return el('span', `chip ${tone}`, label);
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

/** Initials circle with the image layered on top; a failed load peels back. */
function avatarOf(name: string, avatarUrl: string): HTMLElement {
  const avatar = el('span', 'avatar', initialsOf(name) || '•');
  if (/^https:\/\//.test(avatarUrl)) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    img.src = avatarUrl;
    avatar.append(img);
  }
  return avatar;
}

function renderRow(bridge: WidgetBridge, entry: unknown): HTMLElement {
  const record = asRecord(entry);
  const row = el('div', 'row');

  const head = el('div', 'row-head');
  if (str(record.avatarUrl) || str(record.title)) {
    if (str(record.avatarUrl)) head.append(avatarOf(str(record.title), str(record.avatarUrl)));
    head.append(el('div', 'row-title', str(record.title)));
    const chips = Array.isArray(record.chips) ? record.chips : [record.chip];
    for (const entry2 of chips) {
      const chip = chipOf(entry2);
      if (chip) head.append(chip);
    }
    row.append(head);
  }

  if (str(record.meta)) row.append(el('div', 'row-meta', str(record.meta)));

  const people = Array.isArray(record.people) ? record.people : [];
  if (people.length > 0) {
    const line = el('div', 'row-people');
    for (const entry2 of people) {
      const person = asRecord(entry2);
      const name = str(person.name);
      if (!name) continue;
      const item = el('span', 'row-person');
      item.append(avatarOf(name, str(person.avatarUrl)));
      item.append(
        document.createTextNode(str(person.role) ? `${name} · ${str(person.role)}` : name)
      );
      line.append(item);
    }
    row.append(line);
  }

  if (str(record.body)) row.append(el('div', 'row-body', str(record.body)));
  const rowLinks = linksOf(record.links);
  if (rowLinks.length > 0) row.append(linkButtons(bridge, rowLinks));
  return row;
}

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  const results = asRecord(result.structuredContent);

  const card = el('div', 'card');
  if (result.isError) {
    card.append(
      el('div', 'card-title', str(results.title) || 'Results'),
      el('div', 'status error', resultText(result) || 'The results could not be loaded.')
    );
    root.append(card);
    return;
  }

  card.append(el('div', 'card-title', str(results.title)));
  if (str(results.subtitle)) card.append(el('div', 'card-subtitle', str(results.subtitle)));
  const cardLinks = linksOf(results.links);
  if (cardLinks.length > 0) card.append(linkButtons(bridge, cardLinks));

  const groups = Array.isArray(results.groups) ? results.groups : [];
  const flat = Array.isArray(results.rows) ? results.rows : [];
  let anyRow = false;

  if (groups.length > 0) {
    for (const entry of groups) {
      const group = asRecord(entry);
      const rows = Array.isArray(group.rows) ? group.rows : [];
      const header = el('div', 'group-header');
      const chip = chipOf(group.chip) ?? el('span', 'chip neutral', str(group.label) || '—');
      header.append(chip, el('span', 'group-count', String(rows.length)));
      card.append(header);
      const list = el('div', 'rows');
      for (const row of rows) {
        list.append(renderRow(bridge, row));
        anyRow = true;
      }
      card.append(list);
    }
  } else {
    const list = el('div', 'rows');
    for (const row of flat) {
      list.append(renderRow(bridge, row));
      anyRow = true;
    }
    card.append(list);
  }
  if (!anyRow) card.append(el('div', 'row-meta', 'No results.'));

  if (str(results.footer)) card.append(el('div', 'card-subtitle', str(results.footer)));
  root.append(card);
}

const bridge = new WidgetBridge('renkei-results-list');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
