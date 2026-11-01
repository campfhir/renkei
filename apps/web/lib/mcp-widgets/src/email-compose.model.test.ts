/**
 * The email card's rules (email-compose.model.ts): what a preview shows and
 * which fields stay editable, Send and Send later, Discard, and what each
 * answer leaves. The discard and still-editable rules, and what an edited
 * reply sends, used to be driven through the card's iframe
 * (email-card-discard.spec.ts); the spec keeps one Discard press and the
 * browser-only checks. Times are built in
 * the local clock (`new Date(y, m, d, h, min)`) and read back the same way,
 * so the tests hold in any time zone the runner is in.
 */

import {
  MIN_LEAD_MS,
  discardCall,
  discardOutcome,
  emailLayout,
  localDateValue,
  localTimeValue,
  openingReceipt,
  planSend,
  readDraft,
  sendLabel,
  sendOutcome,
  suggestedSendFields,
  textEditable,
  type EmailDraft,
  type EmailFields,
  type PreviewedDraft,
} from './email-compose.model';

const NOW = new Date(2026, 10, 2, 9, 0).getTime();
const tomorrowAt930 = new Date(2026, 10, 3, 9, 30);

const COMPOSE: EmailDraft = {
  draftId: 'AAMkAD-send',
  kind: 'compose',
  messageId: '',
  to: 'dana@example.com',
  cc: '',
  subject: 'Quarterly numbers',
  body: 'Attached.',
};

const REPLY: EmailDraft = {
  draftId: 'AAMkAD-reply',
  kind: 'reply',
  messageId: 'AAMkAD-original',
  to: 'dana@example.com',
  cc: 'lee@example.com',
  subject: 'Re: Quarterly numbers',
  body: 'Thanks — looks good.',
};

/** The fields exactly as the card first shows them for a draft. */
function untouched(draft: EmailDraft, more: Partial<EmailFields> = {}): EmailFields {
  return {
    to: draft.to,
    cc: draft.cc ? draft.cc : null,
    subject: draft.subject,
    body: textEditable(draft) ? draft.body : null,
    day: '',
    clock: '',
    ...more,
  };
}

describe('suggestedSendFields', () => {
  it('pre-fills the time the model picked, in the local clock', () => {
    expect(suggestedSendFields(tomorrowAt930.toISOString(), NOW)).toEqual({
      day: localDateValue(tomorrowAt930),
      clock: '09:30',
    });
  });

  it('pre-fills nothing for no time, nonsense, or a time too close to schedule', () => {
    expect(suggestedSendFields('', NOW)).toBeNull();
    expect(suggestedSendFields('next Tuesday', NOW)).toBeNull();
    expect(suggestedSendFields(new Date(NOW + MIN_LEAD_MS - 1).toISOString(), NOW)).toBeNull();
    expect(suggestedSendFields(new Date(NOW - 3_600_000).toISOString(), NOW)).toBeNull();
  });
});

describe('sendLabel', () => {
  it('reads Schedule as soon as either half of Send later has anything', () => {
    expect(sendLabel('', '')).toBe('Send');
    expect(sendLabel('2026-11-03', '')).toBe('Schedule');
    expect(sendLabel('', '09:30')).toBe('Schedule');
  });
});

describe('planSend: when', () => {
  const day = localDateValue(tomorrowAt930);
  const clock = localTimeValue(tomorrowAt930);

  it('sends now with no sendAt when Send later is empty', () => {
    const plan = planSend(COMPOSE, untouched(COMPOSE), NOW);
    expect(plan.ok && plan.when).toBeNull();
    expect(plan.ok && plan.args).not.toHaveProperty('sendAt');
  });

  it('schedules the picked local time, sent as an instant', () => {
    const plan = planSend(COMPOSE, untouched(COMPOSE, { day, clock }), NOW);
    expect(plan.ok && plan.args.sendAt).toBe(tomorrowAt930.toISOString());
  });

  it('refuses half a time, before any call', () => {
    expect(planSend(COMPOSE, untouched(COMPOSE, { day }), NOW)).toEqual({
      ok: false,
      error: 'Pick both a send date and a time.',
    });
    expect(planSend(COMPOSE, untouched(COMPOSE, { clock }), NOW)).toMatchObject({ ok: false });
  });

  it('refuses a time less than a minute away, or past', () => {
    const soon = new Date(NOW + 30_000);
    const past = new Date(NOW - 3_600_000);
    for (const at of [soon, past]) {
      expect(
        planSend(
          COMPOSE,
          untouched(COMPOSE, { day: localDateValue(at), clock: localTimeValue(at) }),
          NOW
        )
      ).toEqual({ ok: false, error: 'Pick a send time at least a minute from now.' });
    }
  });
});

describe('planSend: a new email', () => {
  it('sends every field, as edited, split into addresses', () => {
    const plan = planSend(
      COMPOSE,
      untouched(COMPOSE, { to: 'dana@example.com, , kim@example.com ', body: 'Edited.' }),
      NOW
    );
    expect(plan).toMatchObject({
      ok: true,
      args: {
        draftId: 'AAMkAD-send',
        overrides: {
          to: ['dana@example.com', 'kim@example.com'],
          cc: [],
          subject: 'Quarterly numbers',
          body: 'Edited.',
        },
      },
    });
  });

  it('refuses with nobody to send to', () => {
    expect(planSend(COMPOSE, untouched(COMPOSE, { to: ' , ' }), NOW)).toEqual({
      ok: false,
      error: 'Add someone to send it to.',
    });
  });
});

describe('planSend: a reply', () => {
  it('goes out as previewed: no overrides, no rebuild', () => {
    expect(planSend(REPLY, untouched(REPLY), NOW)).toMatchObject({
      ok: true,
      args: { draftId: 'AAMkAD-reply' },
    });
    const plan = planSend(REPLY, untouched(REPLY), NOW);
    expect(plan.ok && Object.keys(plan.args)).toEqual(['draftId']);
  });

  it('overrides only what changed; a recipient or subject is no rebuild', () => {
    const plan = planSend(
      REPLY,
      untouched(REPLY, { cc: '', subject: 'Re: Quarterly numbers (final)' }),
      NOW
    );
    expect(plan.ok && plan.args).toEqual({
      draftId: 'AAMkAD-reply',
      overrides: { cc: [], subject: 'Re: Quarterly numbers (final)' },
    });
  });

  it('rebuilds the draft around the thread when its text changed', () => {
    const plan = planSend(REPLY, untouched(REPLY, { body: 'Can we talk Friday?' }), NOW);
    expect(plan.ok && plan.args).toEqual({
      draftId: 'AAMkAD-reply',
      overrides: { comment: 'Can we talk Friday?' },
      replyTo: { messageId: 'AAMkAD-original', kind: 'reply' },
    });
  });

  it('ignores whitespace-only edits to the text', () => {
    const plan = planSend(REPLY, untouched(REPLY, { body: '  Thanks — looks good.\n' }), NOW);
    expect(plan.ok && Object.keys(plan.args)).toEqual(['draftId']);
  });

  it('refuses a reply emptied of its text, but lets a forward go with no note', () => {
    expect(planSend(REPLY, untouched(REPLY, { body: '  ' }), NOW)).toEqual({
      ok: false,
      error: 'Write the reply, or discard it.',
    });
    const forward = { ...REPLY, kind: 'forward' };
    expect(planSend(forward, untouched(forward, { body: '' }), NOW)).toMatchObject({ ok: true });
  });

  it('keeps an old card (no message id) to plain overrides: its text is read-only', () => {
    const old = { ...REPLY, messageId: '' };
    expect(textEditable(old)).toBe(false);
    const plan = planSend(old, untouched(old, { subject: 'Re: changed' }), NOW);
    expect(plan.ok && plan.args).toEqual({
      draftId: 'AAMkAD-reply',
      overrides: { subject: 'Re: changed' },
    });
  });

  it('sends edited recipients, subject and text together, with the message it answers', () => {
    const vendor = {
      ...REPLY,
      to: 'vendor@example.com',
      cc: '',
      subject: 'RE: Invoice 1042',
      body: 'Hi — about invoice 1042.',
      messageId: 'AAMkAD-msg-1042',
    };
    const plan = planSend(
      vendor,
      untouched(vendor, {
        to: 'vendor@example.com, ap@example.com',
        subject: 'RE: Invoice 1042 — paid',
        body: 'Thanks — paid today.',
      }),
      NOW
    );
    expect(plan.ok && plan.args).toEqual({
      draftId: 'AAMkAD-reply',
      overrides: {
        to: ['vendor@example.com', 'ap@example.com'],
        subject: 'RE: Invoice 1042 — paid',
        comment: 'Thanks — paid today.',
      },
      replyTo: { messageId: 'AAMkAD-msg-1042', kind: 'reply' },
    });
  });
});

/** A preview tool's structured content, as the outlook_*_preview tools send it. */
function previewed(more: Record<string, unknown> = {}) {
  return {
    kind: 'compose',
    draftId: 'AAMkAD-a',
    to: ['vendor@example.com'],
    cc: [],
    bcc: [],
    subject: 'Invoice question',
    body: 'Hi — about invoice 1042.',
    bodyHtml: '<p>Hi — about invoice 1042.</p>',
    ...more,
  };
}

function ready(content: unknown): PreviewedDraft {
  const read = readDraft(content, false, '');
  if (!read.ok) throw new Error(`expected a draft, got: ${read.error}`);
  return read.draft;
}

describe('readDraft', () => {
  it('reads the draft the preview made, lists joined for the fields', () => {
    expect(
      ready(previewed({ to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'] }))
    ).toMatchObject({
      draftId: 'AAMkAD-a',
      kind: 'compose',
      messageId: '',
      to: 'a@example.com, b@example.com',
      cc: 'c@example.com',
      subject: 'Invoice question',
      stateKey: 'renkei-email:AAMkAD-a',
      resolved: null,
    });
  });

  it('treats a draft with no kind as a new email', () => {
    expect(ready(previewed({ kind: undefined })).kind).toBe('compose');
  });

  it('shows only why, when the preview failed or made no draft', () => {
    expect(readDraft(previewed(), true, 'Microsoft is not connected.')).toEqual({
      ok: false,
      error: 'Microsoft is not connected.',
    });
    expect(readDraft(previewed({ draftId: '' }), false, '')).toEqual({
      ok: false,
      error: 'The draft could not be created.',
    });
    expect(readDraft(null, false, '')).toMatchObject({ ok: false });
  });
});

describe('which cards open as a form', () => {
  const discarded = { icon: 'cancelled' as const, headline: 'Discarded' };

  it('keeps each draft’s decision under its own key, so discarding one leaves the next a form', () => {
    const first = ready(previewed({ draftId: 'AAMkAD-a' }));
    const next = ready(previewed({ draftId: 'AAMkAD-b' }));
    expect(first.stateKey).not.toBe(next.stateKey);
    // The browser remembers a receipt only for the first card's key; the
    // next card finds nothing under its own and opens editable.
    expect(openingReceipt(next, null)).toBeNull();
    expect(openingReceipt(first, discarded)).toEqual(discarded);
  });

  it('opens on the server’s receipt for this draft over the browser’s', () => {
    const resolved = { icon: 'sent', headline: 'Sent', detail: 'To vendor@example.com' };
    const draft = ready(previewed({ resolved }));
    expect(openingReceipt(draft, discarded)).toEqual(resolved);
  });
});

describe('emailLayout', () => {
  it('a new email: everything editable, its text labelled Body, no thread note', () => {
    expect(emailLayout(ready(previewed()))).toEqual({
      title: 'New email',
      ccEditable: false,
      bcc: null,
      textLabel: 'Body',
      readonlyBody: null,
      quotedThreadNote: false,
    });
  });

  it('a reply: as editable as a new email, and says the thread goes out under it', () => {
    const layout = emailLayout(
      ready(previewed({ kind: 'reply', messageId: 'AAMkAD-msg', cc: ['lee@example.com'] }))
    );
    expect(layout).toMatchObject({
      title: 'Reply',
      ccEditable: true,
      textLabel: 'Body',
      readonlyBody: null,
      quotedThreadNote: true,
    });
  });

  it('a forward’s own text is a Note', () => {
    const layout = emailLayout(ready(previewed({ kind: 'forward', messageId: 'AAMkAD-msg' })));
    expect(layout).toMatchObject({ title: 'Forward', textLabel: 'Note' });
  });

  it('shows Bcc read-only, and only when there is one', () => {
    expect(emailLayout(ready(previewed({ bcc: ['audit@example.com'] }))).bcc).toBe(
      'audit@example.com'
    );
  });

  it('an old reply card (no message id) shows its text as the server rendered it, read-only', () => {
    const old = ready(previewed({ kind: 'replyAll' }));
    expect(emailLayout(old)).toMatchObject({
      title: 'Reply all',
      textLabel: null,
      readonlyBody: { html: '<p>Hi — about invoice 1042.</p>' },
      quotedThreadNote: true,
    });
    expect(emailLayout(ready(previewed({ kind: 'reply', bodyHtml: '' }))).readonlyBody).toEqual({
      text: 'Hi — about invoice 1042.',
    });
  });

  it('titles a kind it does not know plainly', () => {
    expect(emailLayout(ready(previewed({ kind: 'mystery' }))).title).toBe('Email');
  });
});

describe('what Send’s answer leaves', () => {
  const plan = (when: Date | null) => ({
    ok: true as const,
    args: {},
    when,
    to: ['vendor@example.com', 'ap@example.com'],
    subject: 'Invoice question',
  });

  it('a sent email ends on Sent, to whom and about what, and tells the model', () => {
    expect(sendOutcome('reply', plan(null), { isError: false, text: 'Sent.' })).toEqual({
      ok: true,
      done: {
        icon: 'sent',
        headline: 'Sent',
        detail: 'To vendor@example.com, ap@example.com — “Invoice question”',
      },
      context:
        'The user reviewed the Reply preview and sent it to vendor@example.com, ap@example.com.',
    });
  });

  it('a scheduled email ends on Scheduled, with when it sends', () => {
    const outcome = sendOutcome('compose', plan(tomorrowAt930), { isError: false, text: '' });
    expect(outcome).toEqual({
      ok: true,
      done: {
        icon: 'sent',
        headline: 'Scheduled',
        detail: `To vendor@example.com, ap@example.com — “Invoice question” — sends ${tomorrowAt930.toLocaleString()}`,
      },
      context: `The user reviewed the New email preview and scheduled it to vendor@example.com, ap@example.com for ${tomorrowAt930.toISOString()}.`,
    });
  });

  it('leaves the subject out of the receipt when there is none', () => {
    const outcome = sendOutcome(
      'compose',
      { ...plan(null), subject: '' },
      {
        isError: false,
        text: '',
      }
    );
    expect(outcome.ok && outcome.done.detail).toBe('To vendor@example.com, ap@example.com');
  });

  it('carries a link from the answer onto the receipt', () => {
    const outcome = sendOutcome('compose', plan(null), {
      isError: false,
      text: 'Sent. [Open in Outlook](https://outlook.example.com/m/1)',
    });
    expect(outcome.ok && outcome.done.links).toEqual([
      { label: 'Open in Outlook', href: 'https://outlook.example.com/m/1' },
    ]);
  });

  it('a refused send shows why and keeps the card a form', () => {
    expect(sendOutcome('compose', plan(null), { isError: true, text: 'Mailbox full.' })).toEqual({
      ok: false,
      error: 'Mailbox full.',
    });
    expect(sendOutcome('compose', plan(null), { isError: true, text: '' })).toEqual({
      ok: false,
      error: 'Send failed',
    });
    expect(sendOutcome('compose', plan(tomorrowAt930), { isError: true, text: '' })).toEqual({
      ok: false,
      error: 'Scheduling failed',
    });
  });
});

describe('discarding', () => {
  it('deletes the draft by its id alone, whatever was typed into the card', () => {
    expect(discardCall(ready(previewed()))).toEqual({
      name: 'outlook_discard_draft_confirm',
      args: { draftId: 'AAMkAD-a' },
    });
  });

  it('ends on Discarded, nothing sent, and tells the model', () => {
    expect(discardOutcome({ isError: false, text: 'Discarded.' })).toEqual({
      ok: true,
      done: { icon: 'cancelled', headline: 'Discarded', detail: 'Nothing was sent.' },
      context: 'The user discarded the email draft from the preview card. Nothing was sent.',
    });
  });

  it('a refused discard shows why and keeps the card a form', () => {
    expect(discardOutcome({ isError: true, text: 'Draft not found.' })).toEqual({
      ok: false,
      error: 'Draft not found.',
    });
    expect(discardOutcome({ isError: true, text: '' })).toEqual({
      ok: false,
      error: 'Discard failed',
    });
  });
});
