import {
  archiveRequest,
  canSave,
  chatArchiveReducer,
  initChatArchive,
  parseArchiveDays,
  refusalWords,
  retentionNote,
  saveLabel,
  type ChatArchiveAction,
  type ChatArchiveState,
} from './chat-archive-form.model';

function run(afterDays: number | null, ...actions: ChatArchiveAction[]): ChatArchiveState {
  return actions.reduce(chatArchiveReducer, initChatArchive(afterDays));
}

const typed = (input: string): ChatArchiveAction => ({ type: 'typed', input });

describe('Archive old chats', () => {
  it('by default never archives: an empty field, and nothing to save yet', () => {
    const state = run(null);
    expect(state.input).toBe('');
    expect(canSave(state)).toBe(false);
    expect(saveLabel(state)).toBe('Save');
  });

  it('opens with the saved number of days', () => {
    expect(run(30).input).toBe('30');
    expect(canSave(run(30))).toBe(false);
  });

  it('typing a number turns Save on; typing it back to what is saved turns it off', () => {
    expect(canSave(run(null, typed('30')))).toBe(true);
    expect(canSave(run(30, typed('31'), typed(' 30 ')))).toBe(false);
  });

  it('an empty field saves as never', () => {
    expect(parseArchiveDays('  ', 365)).toEqual({ days: null });
    expect(archiveRequest(null)).toEqual({ chatArchive: { afterDays: null } });
  });

  it('a whole number of days the org allows is what Save sends', () => {
    expect(parseArchiveDays(' 30 ', 365)).toEqual({ days: 30 });
    expect(archiveRequest(30)).toEqual({ chatArchive: { afterDays: 30 } });
  });

  it('refuses a fraction, zero or words before anything is sent', () => {
    const words = 'Enter a whole number of days, or leave it empty to never archive.';
    expect(parseArchiveDays('2.5', 365)).toEqual({ error: words });
    expect(parseArchiveDays('0', 365)).toEqual({ error: words });
    expect(parseArchiveDays('soon', 365)).toEqual({ error: words });
  });

  it('refuses longer than the organization keeps chats, naming the most it can be', () => {
    expect(parseArchiveDays('366', 365)).toEqual({ error: 'Enter 365 days or fewer.' });
    expect(parseArchiveDays('365', 365)).toEqual({ days: 365 });
  });

  it('a refusal shows its words and keeps the entry, and typing clears it', () => {
    const refused = run(30, typed('366'), { type: 'failed', problem: 'Enter 365 days or fewer.' });
    expect(refused.status).toBe('failed');
    expect(refused.problem).toBe('Enter 365 days or fewer.');
    expect(refused.input).toBe('366');
    const retyped = chatArchiveReducer(refused, typed('36'));
    expect(retyped.problem).toBeNull();
    expect(retyped.status).toBe('idle');
  });

  it('while saving Save is off and reads "Saving…"', () => {
    const state = run(null, typed('30'), { type: 'sent' });
    expect(canSave(state)).toBe(false);
    expect(saveLabel(state)).toBe('Saving…');
  });

  it('a stored save says "Saved." and leaves nothing to save', () => {
    const state = run(null, typed(' 30 '), { type: 'sent' }, { type: 'stored' });
    expect(state.status).toBe('saved');
    expect(state.saved).toBe('30');
    expect(canSave(state)).toBe(false);
  });

  it('clearing a saved window back to empty is a change to save', () => {
    expect(canSave(run(30, typed('')))).toBe(true);
  });

  it('shows the server’s refusal, or "Could not save." when it gave none', () => {
    expect(
      refusalWords({
        error: 'Archiving cannot be longer than the organization keeps chats (365 days)',
      })
    ).toBe('Archiving cannot be longer than the organization keeps chats (365 days)');
    expect(refusalWords(null)).toBe('Could not save.');
    expect(refusalWords({ error: 42 })).toBe('Could not save.');
  });

  it('the note names the org’s retention as the ceiling, or says what empty means', () => {
    expect(retentionNote(365)).toBe(
      'Your organization keeps chats for 365 days, so this can be at most 365. Chats are deleted after that, whatever this is set to.'
    );
    expect(retentionNote(0)).toBe(
      'Leave it empty to keep every chat in the list until you archive it yourself.'
    );
  });
});
