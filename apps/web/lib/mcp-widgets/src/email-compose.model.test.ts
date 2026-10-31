/**
 * The email card's send rules (email-compose.model.ts). Times are built in
 * the local clock (`new Date(y, m, d, h, min)`) and read back the same way,
 * so the tests hold in any time zone the runner is in.
 */

import {
  MIN_LEAD_MS,
  localDateValue,
  localTimeValue,
  planSend,
  sendLabel,
  suggestedSendFields,
  textEditable,
  type EmailDraft,
  type EmailFields,
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
});
