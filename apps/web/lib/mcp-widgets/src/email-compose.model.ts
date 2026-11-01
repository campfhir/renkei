/**
 * The email card's rules (email-compose.ts), with no DOM and no clock of
 * its own: what a preview shows and which fields the person can change,
 * what Send later pre-fills, when Send reads Schedule, what is refused
 * before any call, exactly what `outlook_send_draft_confirm` and
 * `outlook_discard_draft_confirm` are sent, and the receipt and model note
 * each answer leaves. The card reads its fields, passes them and the time
 * in, and renders what comes back. Tested in email-compose.model.test.ts.
 */

import { asRecord } from '@renkei/guards';
import { doneStateOf, parseLinks, splitAddresses, str, strings, type DoneState } from './ui';

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

/** The card's title for each kind of draft. */
export const KIND_TITLES: Record<string, string> = {
  compose: 'New email',
  reply: 'Reply',
  replyAll: 'Reply all',
  forward: 'Forward',
};

/** The draft a preview tool's result shows, as the card reads it. */
export interface PreviewedDraft extends EmailDraft {
  bcc: string;
  /** The server's rendering of the body, shown where the text is read-only. */
  bodyHtml: string;
  /** The send time the model suggested (an instant), or ''. */
  sendAt: string;
  /** Where this draft's decision is kept: one draft, one key. */
  stateKey: string;
  /** The receipt the server holds for this draft, if it was decided (on any device). */
  resolved: DoneState | null;
}

export type DraftRead = { ok: true; draft: PreviewedDraft } | { ok: false; error: string };

/**
 * What a preview tool's result shows: the draft, or — when the tool failed
 * or made no draft — only the line saying why. `errorText` is the result's
 * own text.
 */
export function readDraft(
  structuredContent: unknown,
  isError: boolean,
  errorText: string
): DraftRead {
  const draft = asRecord(structuredContent);
  const draftId = str(draft.draftId);
  if (isError || !draftId) {
    return { ok: false, error: errorText || 'The draft could not be created.' };
  }
  return {
    ok: true,
    draft: {
      draftId,
      kind: str(draft.kind) || 'compose',
      messageId: str(draft.messageId),
      to: strings(draft.to).join(', '),
      cc: strings(draft.cc).join(', '),
      bcc: strings(draft.bcc).join(', '),
      subject: str(draft.subject),
      body: str(draft.body),
      bodyHtml: str(draft.bodyHtml),
      sendAt: str(draft.sendAt),
      stateKey: `renkei-email:${draftId}`,
      resolved: doneStateOf(draft.resolved),
    },
  };
}

/**
 * The receipt a card opens on instead of its form: its own draft's, from
 * the server first, else from this browser. Keyed by the draft, so
 * deciding one card never turns another into a receipt — the next draft
 * in the chat opens as a live form.
 */
export function openingReceipt(
  draft: Pick<PreviewedDraft, 'resolved'>,
  remembered: DoneState | null
): DoneState | null {
  return draft.resolved ?? remembered;
}

/** Which fields the card draws, and which of them the person can change. */
export interface EmailLayout {
  title: string;
  /** To and Subject are always editable; Cc only when the draft has one. */
  ccEditable: boolean;
  /** Shown read-only, or null for none. */
  bcc: string | null;
  /** The editable text's label, or null where the text is read-only. */
  textLabel: 'Body' | 'Note' | null;
  /** The read-only body: the server's rendering where it sent one, else the plain text. */
  readonlyBody: { html: string } | { text: string } | null;
  /** A reply or forward: the quoted thread goes out under the person's text. */
  quotedThreadNote: boolean;
}

export function emailLayout(draft: PreviewedDraft): EmailLayout {
  const editable = textEditable(draft);
  return {
    title: KIND_TITLES[draft.kind] ?? 'Email',
    ccEditable: draft.cc !== '',
    bcc: draft.bcc || null,
    textLabel: !editable ? null : draft.kind === 'forward' ? 'Note' : 'Body',
    readonlyBody: editable
      ? null
      : draft.bodyHtml
        ? { html: draft.bodyHtml }
        : { text: draft.body },
    quotedThreadNote: draft.kind !== 'compose',
  };
}

export type Outcome =
  | { ok: true; done: DoneState; context: string }
  /** The line the card shows; its buttons come back so the person can try again. */
  | { ok: false; error: string };

type PlannedSend = Extract<SendPlan, { ok: true }>;

/** What the send tool's answer leaves: a receipt and a note to the model, or why it failed. */
export function sendOutcome(
  kind: string,
  plan: PlannedSend,
  answer: { isError: boolean; text: string }
): Outcome {
  const { when } = plan;
  if (answer.isError) {
    return { ok: false, error: answer.text || (when ? 'Scheduling failed' : 'Send failed') };
  }
  const sentTo = plan.to.join(', ');
  const what = `To ${sentTo}${plan.subject ? ` — “${plan.subject}”` : ''}`;
  const links = parseLinks(answer.text);
  const card = KIND_TITLES[kind] ?? 'email';
  return {
    ok: true,
    done: {
      icon: 'sent',
      ...(links.length > 0 ? { links } : {}),
      headline: when ? 'Scheduled' : 'Sent',
      detail: when ? `${what} — sends ${when.toLocaleString()}` : what,
    },
    context: when
      ? `The user reviewed the ${card} preview and scheduled it to ${sentTo} for ${when.toISOString()}.`
      : `The user reviewed the ${card} preview and sent it to ${sentTo}.`,
  };
}

/** Discard deletes the draft, whatever the fields say: it sends only the draft's id. */
export function discardCall(draft: Pick<EmailDraft, 'draftId'>): {
  name: 'outlook_discard_draft_confirm';
  args: { draftId: string };
} {
  return { name: 'outlook_discard_draft_confirm', args: { draftId: draft.draftId } };
}

/** What the discard tool's answer leaves: a receipt and a note to the model, or why it failed. */
export function discardOutcome(answer: { isError: boolean; text: string }): Outcome {
  if (answer.isError) return { ok: false, error: answer.text || 'Discard failed' };
  return {
    ok: true,
    done: { icon: 'cancelled', headline: 'Discarded', detail: 'Nothing was sent.' },
    context: 'The user discarded the email draft from the preview card. Nothing was sent.',
  };
}
