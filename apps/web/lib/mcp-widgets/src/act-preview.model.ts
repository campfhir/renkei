/**
 * The act-preview card's rules (act-preview.ts, act-render.ts), with no DOM:
 * whether a result is a card at all, which of the card's words the person
 * may rewrite, exactly what the `_confirm` twin is called with, what the
 * card collapses to once decided, and what the model is told. The card
 * draws what these return and makes the calls; tested in
 * act-preview.model.test.ts.
 */

import { asRecord } from '@renkei/guards';
import type { ActCard, Editable } from './act-card';
import type { DoneState } from './ui';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/* ------------------------------------------------------------------ */
/* Reading the payload                                                  */
/* ------------------------------------------------------------------ */

/** The card, if this is one; a result from an older server or an error is not. */
export function readCard(value: unknown): ActCard | null {
  const record = asRecord(value);
  if (record.kind !== 'act') return null;
  const body = asRecord(record.body);
  if (typeof body.kind !== 'string' || typeof record.confirmTool !== 'string') return null;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return record as unknown as ActCard;
}

/**
 * What a result that is not a card shows instead: its title (or "Action")
 * and the server's words (or a plain line). `text` is the result's text.
 */
export function unpreparedCard(
  structuredContent: unknown,
  text: string
): { title: string; error: string } {
  return {
    title: str(asRecord(structuredContent).title) || 'Action',
    error: text || 'The preview could not be prepared.',
  };
}

/**
 * Where this card's decision is kept: keyed by the id minted for THIS card,
 * so a second preview of the same act never recalls the first one's
 * receipt. A card without an id keeps nothing ('').
 */
export function decisionKey(card: Pick<ActCard, 'previewId'>): string {
  return card.previewId ? `renkei-preview:${card.previewId}` : '';
}

/** The fields the card lets the person rewrite; anything else in `editable` is ignored. */
export function editableFields(card: Pick<ActCard, 'editable'>): Editable[] {
  return Array.isArray(card.editable) ? card.editable : [];
}

/** The confirm button's word: the card's own label, else its verb, else "Confirm". */
export function confirmLabel(card: Pick<ActCard, 'confirmLabel' | 'verb'>): string {
  return str(card.confirmLabel) || str(card.verb) || 'Confirm';
}

/* ------------------------------------------------------------------ */
/* Words: read-only or a box                                            */
/* ------------------------------------------------------------------ */

/** How a block of words on the card is drawn. */
export type WordsView =
  | { kind: 'none' }
  | { kind: 'read'; text: string }
  | {
      kind: 'edit';
      /** The confirm argument the box writes. */
      key: string;
      value: string;
      /** The box's accessible name. */
      label: string;
      /** A one-line input rather than a text area. */
      singleLine: boolean;
    };

/**
 * Words the model drafted, as the card shows them: a box when the card
 * lists `key` as editable (even empty, so the person can write them), the
 * words read-only when it does not, and nothing when there are none to
 * read.
 */
export function wordsView(
  editable: readonly Editable[],
  key: string | undefined,
  text: string | undefined,
  label?: string
): WordsView {
  if (text === undefined && !key) return { kind: 'none' };
  const value = text ?? '';
  const spec = key ? editable.find((entry) => entry.key === key) : undefined;
  if (!key || !spec) return value ? { kind: 'read', text: value } : { kind: 'none' };
  return {
    kind: 'edit',
    key,
    value,
    label: spec.label || label || key,
    singleLine: spec.multiline === false,
  };
}

/* ------------------------------------------------------------------ */
/* Confirm and cancel                                                   */
/* ------------------------------------------------------------------ */

/**
 * The `_confirm` twin's arguments: the model's proposal with each box the
 * card drew written over it (trimmed). An emptied box means "leave it as
 * the model proposed", never "send an empty required argument"; an
 * argument the model never proposed and the person left empty is not sent.
 */
export function confirmArgs(
  card: Pick<ActCard, 'confirmArgs'>,
  edits: ReadonlyMap<string, string> | Readonly<Record<string, string>>
): Record<string, unknown> {
  const original = asRecord(card.confirmArgs);
  const args: Record<string, unknown> = { ...original };
  const entries = edits instanceof Map ? [...edits] : Object.entries(edits);
  for (const [key, raw] of entries) {
    const value = raw.trim();
    if (value) args[key] = value;
    else if (original[key] === undefined) delete args[key];
  }
  return args;
}

/** What one decision leaves: the receipt, and the line the model is told. */
export interface Decision {
  done: DoneState;
  modelContext: string;
}

export type ConfirmOutcome = ({ ok: true } & Decision) | { ok: false; error: string };

/**
 * What the twin's answer does. A refusal stays on the card as its words
 * (the buttons come back to try again); anything else collapses the card
 * to the answer's first line, with the links it named, and tells the model
 * the whole answer.
 */
export function confirmOutcome(
  card: Pick<ActCard, 'title'>,
  answer: { isError?: boolean; text: string; links?: DoneState['links'] }
): ConfirmOutcome {
  const reply = answer.text;
  if (answer.isError) return { ok: false, error: reply || 'The action failed' };
  const title = str(card.title);
  const links = answer.links ?? [];
  return {
    ok: true,
    done: {
      icon: 'sent',
      headline: reply.split('\n')[0] || 'Done',
      detail: title,
      ...(links.length > 0 ? { links } : {}),
    },
    modelContext: `The user confirmed "${title}" on the preview card. Result: ${reply}`,
  };
}

/** Cancel runs nothing: the receipt says so, and so does the line the model is told. */
export function cancelDecision(card: Pick<ActCard, 'title'>): Decision {
  return {
    done: { icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing changed.' },
    modelContext: `The user cancelled "${str(card.title)}" from the preview card. Nothing changed.`,
  };
}

/* ------------------------------------------------------------------ */
/* When                                                                 */
/* ------------------------------------------------------------------ */

const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/**
 * A date or date-time as the tool wrote it, kept on its own clock: the
 * parts land in a UTC Date only so they can be formatted back unchanged.
 */
export function whenParts(text: string): { date: Date; hasTime: boolean } | null {
  const match = WHEN.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  return {
    date: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0))),
    hasTime: h !== undefined,
  };
}

const clockOf = (date: Date) =>
  date.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/** "2026-10-21T14:00:00" → "Wed, Oct 21, 2026 · 2:00 PM", as written, with no zone conversion. */
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
  return parts.hasTime ? `${day} · ${clockOf(parts.date)}` : day;
}

/** The calendar day as written (the UTC day of `whenParts`'s Date), never the viewer's. */
const writtenDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * An event's start and end as one line: an end on the same written day
 * reads as just its time; any other end is written out in full; no end, no
 * dash. "Same day" is the day as written — the viewer's own time zone
 * plays no part, as nowhere else on the card.
 */
export function eventSpan(start: string, end: string | undefined): string {
  const from = whenParts(start);
  const to = end ? whenParts(end) : null;
  const startText = formatWhen(start);
  const endText =
    to && from && to.hasTime && writtenDay(to.date) === writtenDay(from.date)
      ? clockOf(to.date)
      : end
        ? formatWhen(end)
        : '';
  return endText ? `${startText} – ${endText}` : startText;
}
