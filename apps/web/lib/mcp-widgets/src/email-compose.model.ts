/**
 * The email card's rules (email-compose.ts), with no DOM and no clock of
 * its own: what Send later pre-fills, when Send reads Schedule, what is
 * refused before any call, and exactly what `outlook_send_draft_confirm`
 * is sent. The card reads its fields, passes them and the time in, and
 * renders what comes back. Tested in email-compose.model.test.ts.
 */

import { splitAddresses } from './ui';

/** How far ahead a scheduled send has to be, at the least. */
export const MIN_LEAD_MS = 60_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** A moment's local calendar day, as a date input holds it (`YYYY-MM-DD`). */
export function localDateValue(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A moment's local clock time, as a time input holds it (`HH:mm`). */
export function localTimeValue(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The send time the model picked, as the picker's two fields in the
 * viewer's local clock — or none, when it named none, named nonsense, or
 * named a time already too close to schedule (pre-filling a refusal helps
 * nobody).
 */
export function suggestedSendFields(
  sendAt: string,
  now: number
): { day: string; clock: string } | null {
  if (!sendAt) return null;
  const at = new Date(sendAt);
  if (Number.isNaN(at.getTime()) || at.getTime() < now + MIN_LEAD_MS) return null;
  return { day: localDateValue(at), clock: localTimeValue(at) };
}

/** The confirm button's word: anything in Send later makes it Schedule. */
export function sendLabel(day: string, clock: string): 'Schedule' | 'Send' {
  return day || clock ? 'Schedule' : 'Send';
}

/** The draft as the preview showed it. */
export interface EmailDraft {
  draftId: string;
  kind: string;
  /** The message a reply or forward answers; '' on a card from before previews carried it. */
  messageId: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
}

/** The card's fields as the person left them. `body` is null where it shows no editable text. */
export interface EmailFields {
  to: string;
  cc: string | null;
  subject: string;
  body: string | null;
  /** Send later's two halves, as the inputs hold them ('' when empty). */
  day: string;
  clock: string;
}

export type SendPlan =
  | { ok: true; args: Record<string, unknown>; when: Date | null; to: string[]; subject: string }
  | { ok: false; error: string };

/** Whether the card lets the person rewrite the text (a reply rebuilds it around the thread). */
export function textEditable(draft: Pick<EmailDraft, 'kind' | 'messageId'>): boolean {
  return draft.kind === 'compose' || draft.messageId !== '';
}

/**
 * What pressing Send (or Schedule) does: the confirm tool's arguments, or
 * the line the card shows instead of calling it.
 *
 * A new email sends every field. A reply goes out as previewed except for
 * what changed: a changed recipient or subject is a plain override, and
 * only a changed text rebuilds the draft (`replyTo`).
 */
export function planSend(draft: EmailDraft, fields: EmailFields, now: number): SendPlan {
  const compose = draft.kind === 'compose';
  const to = splitAddresses(fields.to);
  const cc = fields.cc === null ? [] : splitAddresses(fields.cc);
  let args: Record<string, unknown>;
  if (compose) {
    args = {
      overrides: { to, cc, subject: fields.subject, body: fields.body ?? draft.body },
    };
  } else {
    const comment = fields.body ?? draft.body;
    const textEdited =
      draft.messageId !== '' && fields.body !== null && comment.trim() !== draft.body.trim();
    if (textEdited && !comment.trim() && draft.kind !== 'forward') {
      return { ok: false, error: 'Write the reply, or discard it.' };
    }
    const overrides = {
      ...(to.join(', ') !== draft.to ? { to } : {}),
      ...(fields.cc !== null && cc.join(', ') !== draft.cc ? { cc } : {}),
      ...(fields.subject.trim() !== draft.subject.trim() ? { subject: fields.subject } : {}),
      ...(textEdited ? { comment } : {}),
    };
    args = {
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      ...(textEdited ? { replyTo: { messageId: draft.messageId, kind: draft.kind } } : {}),
    };
  }
  if (to.length === 0) return { ok: false, error: 'Add someone to send it to.' };

  let when: Date | null = null;
  if (fields.day || fields.clock) {
    if (!fields.day || !fields.clock) {
      return { ok: false, error: 'Pick both a send date and a time.' };
    }
    // No offset in the string: it reads as the viewer's local time.
    when = new Date(`${fields.day}T${fields.clock}`);
    if (Number.isNaN(when.getTime()) || when.getTime() < now + MIN_LEAD_MS) {
      return { ok: false, error: 'Pick a send time at least a minute from now.' };
    }
  }
  return {
    ok: true,
    args: { draftId: draft.draftId, ...args, ...(when ? { sendAt: when.toISOString() } : {}) },
    when,
    to,
    subject: fields.subject,
  };
}
