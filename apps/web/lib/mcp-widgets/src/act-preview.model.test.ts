/**
 * The act-preview card's rules (act-preview.model.ts): what used to be
 * proved by pressing buttons inside the card's iframe
 * (e2e/act-preview.spec.ts), plus what the card decides that no spec
 * looked at.
 */

import type { ActCard } from './act-card';
import {
  cancelDecision,
  confirmArgs,
  confirmLabel,
  confirmOutcome,
  decisionKey,
  editableFields,
  eventSpan,
  formatWhen,
  readCard,
  unpreparedCard,
  whenParts,
  wordsView,
} from './act-preview.model';

/** The card jira_add_comment_preview draws for "Tell PROJ-12 it looks good." */
const COMMENT: ActCard = {
  kind: 'act',
  previewId: 'pv-1',
  verb: 'Comment',
  icon: 'comment',
  title: 'Comment on PROJ-12',
  subtitle: 'Jira · Acme',
  confirmLabel: 'Post comment',
  editable: [{ key: 'comment', label: 'Comment' }],
  body: {
    kind: 'comment',
    mode: 'add',
    on: { label: 'PROJ-12' },
    bodyKey: 'comment',
    body: 'Looks good to me — shipping Friday.',
  },
  confirmTool: 'jira_add_comment_confirm',
  confirmArgs: { issueKey: 'PROJ-12', comment: 'Looks good to me — shipping Friday.' },
};

describe('reading the payload', () => {
  it('draws an act card, and nothing else as one', () => {
    expect(readCard(COMMENT)).toBe(COMMENT);
    expect(readCard({ ...COMMENT, kind: 'issue' })).toBeNull();
    expect(readCard({ ...COMMENT, body: {} })).toBeNull();
    expect(readCard({ ...COMMENT, confirmTool: undefined })).toBeNull();
    expect(readCard(null)).toBeNull();
    expect(readCard('Commented.')).toBeNull();
  });

  it('a preview that could not be prepared shows its title and the server’s words', () => {
    expect(unpreparedCard({ title: 'Move PROJ-12' }, 'Jira is not connected.')).toEqual({
      title: 'Move PROJ-12',
      error: 'Jira is not connected.',
    });
  });

  it('a preview with no title and no words still says what happened', () => {
    expect(unpreparedCard(undefined, '')).toEqual({
      title: 'Action',
      error: 'The preview could not be prepared.',
    });
  });

  it('keeps each card’s decision under its own preview id, and none without one', () => {
    expect(decisionKey(COMMENT)).toBe('renkei-preview:pv-1');
    expect(decisionKey({ ...COMMENT, previewId: 'pv-2' })).not.toBe(decisionKey(COMMENT));
    expect(decisionKey({ ...COMMENT, previewId: '' })).toBe('');
  });

  it('the confirm button reads the card’s label, else its verb, else Confirm', () => {
    expect(confirmLabel(COMMENT)).toBe('Post comment');
    expect(confirmLabel({ verb: 'Delete' })).toBe('Delete');
    expect(confirmLabel({ verb: '' })).toBe('Confirm');
  });
});

describe('which words the person may rewrite', () => {
  const editable = editableFields(COMMENT);

  it('the comment the card lists as editable is a box holding the model’s words', () => {
    expect(wordsView(editable, 'comment', 'Looks good.', 'Comment')).toEqual({
      kind: 'edit',
      key: 'comment',
      value: 'Looks good.',
      label: 'Comment',
      singleLine: false,
    });
  });

  it('words the card does not list are shown read-only', () => {
    expect(wordsView(editable, 'note', 'Pairing on the migration.')).toEqual({
      kind: 'read',
      text: 'Pairing on the migration.',
    });
    expect(wordsView(editable, undefined, 'Why not a Map here?')).toEqual({
      kind: 'read',
      text: 'Why not a Map here?',
    });
  });

  it('no words to read shows nothing', () => {
    expect(wordsView(editable, undefined, undefined)).toEqual({ kind: 'none' });
    expect(wordsView(editable, 'note', undefined)).toEqual({ kind: 'none' });
    expect(wordsView(editable, undefined, '')).toEqual({ kind: 'none' });
  });

  it('an editable field the model left empty is still a box, so the person can write it', () => {
    expect(wordsView(editable, 'comment', undefined, 'Comment')).toMatchObject({
      kind: 'edit',
      value: '',
    });
  });

  it('a box is named by the card’s label, else the layout’s, else its argument', () => {
    const unnamed = [{ key: 'message', label: '' }];
    expect(wordsView(unnamed, 'message', 'x', 'Commit message')).toMatchObject({
      label: 'Commit message',
    });
    expect(wordsView(unnamed, 'message', 'x')).toMatchObject({ label: 'message' });
  });

  it('a field marked single-line is a one-line input, any other a text area', () => {
    const title = [{ key: 'title', label: 'Title', multiline: false }];
    expect(wordsView(title, 'title', 'Handbook')).toMatchObject({ singleLine: true });
    const body = [{ key: 'body', label: 'Body', multiline: true }];
    expect(wordsView(body, 'body', 'Text')).toMatchObject({ singleLine: false });
  });

  it('a card whose editable list is malformed edits nothing', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const broken = { editable: 'comment' } as unknown as Pick<ActCard, 'editable'>;
    expect(editableFields(broken)).toEqual([]);
    expect(editableFields({})).toEqual([]);
  });
});

describe('what confirm sends the twin', () => {
  it('sends the person’s rewrite over the model’s words, with every other argument unchanged', () => {
    expect(confirmArgs(COMMENT, { comment: 'Approved — please ship it today.' })).toEqual({
      issueKey: 'PROJ-12',
      comment: 'Approved — please ship it today.',
    });
  });

  it('sends the model’s proposal untouched when nothing was edited', () => {
    expect(confirmArgs(COMMENT, { comment: 'Looks good to me — shipping Friday.' })).toEqual(
      COMMENT.confirmArgs
    );
    expect(confirmArgs(COMMENT, new Map())).toEqual(COMMENT.confirmArgs);
  });

  it('trims the spaces around a rewrite', () => {
    expect(confirmArgs(COMMENT, new Map([['comment', '  Ship it.\n']]))).toMatchObject({
      comment: 'Ship it.',
    });
  });

  it('an emptied box keeps the model’s words rather than sending an empty argument', () => {
    expect(confirmArgs(COMMENT, { comment: '   ' })).toEqual(COMMENT.confirmArgs);
  });

  it('an argument the model never proposed is sent only when the person wrote it', () => {
    const card = { confirmArgs: { issueKey: 'PROJ-12', transition: 'Done' } };
    expect(confirmArgs(card, { comment: '' })).toEqual(card.confirmArgs);
    expect(confirmArgs(card, { comment: 'Shipped.' })).toEqual({
      ...card.confirmArgs,
      comment: 'Shipped.',
    });
    expect('comment' in confirmArgs({ confirmArgs: { comment: undefined } }, { comment: '' })).toBe(
      false
    );
  });

  it('does not change the card’s own arguments', () => {
    const before = { ...COMMENT.confirmArgs };
    confirmArgs(COMMENT, { comment: 'Changed.' });
    expect(COMMENT.confirmArgs).toEqual(before);
  });

  it('a card with no arguments object still confirms with the person’s words', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const card = { confirmArgs: null } as unknown as Pick<ActCard, 'confirmArgs'>;
    expect(confirmArgs(card, { comment: 'Hi' })).toEqual({ comment: 'Hi' });
  });
});

describe('after confirm', () => {
  it('collapses to the answer’s first line under the card’s title, and tells the model the whole answer', () => {
    const outcome = confirmOutcome(COMMENT, {
      text: 'Commented on PROJ-12.\nComment id 10001',
    });
    expect(outcome).toEqual({
      ok: true,
      done: { icon: 'sent', headline: 'Commented on PROJ-12.', detail: 'Comment on PROJ-12' },
      modelContext:
        'The user confirmed "Comment on PROJ-12" on the preview card. ' +
        'Result: Commented on PROJ-12.\nComment id 10001',
    });
  });

  it('keeps the links the answer named on the receipt', () => {
    const links = [{ label: 'Open in Jira', href: 'https://acme.atlassian.net/browse/PROJ-12' }];
    const outcome = confirmOutcome(COMMENT, { text: 'Commented on PROJ-12.', links });
    expect(outcome.ok && outcome.done.links).toEqual(links);
    const none = confirmOutcome(COMMENT, { text: 'Commented on PROJ-12.', links: [] });
    expect(none.ok && 'links' in none.done).toBe(false);
  });

  it('an empty answer still reads Done', () => {
    const outcome = confirmOutcome(COMMENT, { text: '' });
    expect(outcome.ok && outcome.done.headline).toBe('Done');
  });

  it('a refused confirm stays on the card with the server’s words, and the model is told nothing', () => {
    expect(confirmOutcome(COMMENT, { isError: true, text: 'PROJ-12 is closed.' })).toEqual({
      ok: false,
      error: 'PROJ-12 is closed.',
    });
    expect(confirmOutcome(COMMENT, { isError: true, text: '' })).toEqual({
      ok: false,
      error: 'The action failed',
    });
  });
});

describe('cancel', () => {
  it('runs nothing, says nothing changed, and tells the model so', () => {
    expect(cancelDecision(COMMENT)).toEqual({
      done: { icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing changed.' },
      modelContext:
        'The user cancelled "Comment on PROJ-12" from the preview card. Nothing changed.',
    });
  });
});

describe('when an event or worklog happens', () => {
  it('reads a date-time as written, with no time zone conversion', () => {
    expect(formatWhen('2026-10-21T14:00:00')).toBe('Wed, Oct 21, 2026 · 2:00 PM');
    expect(formatWhen('2026-10-21T09:05:00Z')).toBe('Wed, Oct 21, 2026 · 9:05 AM');
  });

  it('a date alone reads as the day, and anything else as written', () => {
    expect(formatWhen('2026-10-21')).toBe('Wed, Oct 21, 2026');
    expect(formatWhen('next Tuesday')).toBe('next Tuesday');
    expect(whenParts('next Tuesday')).toBeNull();
  });

  it('an event ending the same day shows the end as just its time', () => {
    expect(eventSpan('2026-10-21T09:00:00', '2026-10-21T09:15:00')).toBe(
      'Wed, Oct 21, 2026 · 9:00 AM – 9:15 AM'
    );
  });

  it('an event ending on another day writes the end out in full', () => {
    expect(eventSpan('2026-10-21T23:00:00', '2026-10-22T01:00:00')).toBe(
      'Wed, Oct 21, 2026 · 11:00 PM – Thu, Oct 22, 2026 · 1:00 AM'
    );
  });

  it('same day means the day as written, whatever the viewer’s time zone', () => {
    // Early on the written day: in a zone behind UTC the start would fall
    // on the day before, which once made the end read in full.
    expect(eventSpan('2026-10-21T02:00:00', '2026-10-21T09:00:00')).toBe(
      'Wed, Oct 21, 2026 · 2:00 AM – 9:00 AM'
    );
  });

  it('an all-day end, or no end, reads plainly', () => {
    expect(eventSpan('2026-10-21', '2026-10-22')).toBe('Wed, Oct 21, 2026 – Thu, Oct 22, 2026');
    expect(eventSpan('2026-10-21T09:00:00', undefined)).toBe('Wed, Oct 21, 2026 · 9:00 AM');
  });
});
