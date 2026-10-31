/**
 * The Knowledge panel's behaviour (knowledge-panel.model.ts), as a person
 * using it would describe it. The browser spec (knowledge-panel.spec.ts)
 * keeps only that the panel renders real notes and fits the page.
 */

import {
  bulkRemoval,
  canSave,
  initialKnowledge,
  knowledgeReducer,
  preview,
  saveRequest,
  selectAllBox,
  type KnowledgeAction,
  type KnowledgeState,
  type NoteRow,
} from './knowledge-panel.model';

const note = (noteId: string, more: Partial<NoteRow> = {}): NoteRow => ({
  noteId,
  title: `Note ${noteId}`,
  content: `About ${noteId}.`,
  authoredBy: 'user',
  sourceAt: null,
  ...more,
});

const run = (actions: KnowledgeAction[], from: KnowledgeState = initialKnowledge) =>
  actions.reduce(knowledgeReducer, from);

const loaded = (...ids: string[]) => run([{ type: 'loaded', notes: ids.map((id) => note(id)) }]);

describe('loading', () => {
  it('knows nothing until the first load answers, then knows the notes', () => {
    expect(initialKnowledge.notes).toBeNull();
    expect(loaded().notes).toEqual([]);
    expect(loaded('a', 'b').notes?.map((n) => n.noteId)).toEqual(['a', 'b']);
  });

  it('shows a failed load, and clears it on the next good one', () => {
    const failed = run([{ type: 'loadFailed', error: 'Not allowed' }]);
    expect(failed.error).toBe('Not allowed');
    expect(run([{ type: 'loaded', notes: [] }], failed).error).toBeNull();
  });
});

describe('selection', () => {
  it('says "Select all" with nothing chosen, and how many once something is', () => {
    const state = loaded('a', 'b', 'c');
    expect(selectAllBox(state)).toEqual({
      checked: false,
      indeterminate: false,
      label: 'Select all',
    });
    const one = run([{ type: 'toggle', noteId: 'b' }], state);
    expect(selectAllBox(one)).toEqual({ checked: false, indeterminate: true, label: '1 selected' });
  });

  it('a second press on a row takes it back off', () => {
    const state = run(
      [
        { type: 'toggle', noteId: 'a' },
        { type: 'toggle', noteId: 'a' },
      ],
      loaded('a', 'b')
    );
    expect(state.selected.size).toBe(0);
  });

  it('select all picks every note, and pressed again picks none', () => {
    const all = run([{ type: 'toggleAll' }], loaded('a', 'b'));
    expect(selectAllBox(all)).toEqual({ checked: true, indeterminate: false, label: '2 selected' });
    expect(run([{ type: 'toggleAll' }], all).selected.size).toBe(0);
  });

  it('from part of the notes, select all picks the rest', () => {
    const state = run([{ type: 'toggle', noteId: 'a' }, { type: 'toggleAll' }], loaded('a', 'b'));
    expect([...state.selected].sort()).toEqual(['a', 'b']);
  });

  it('select all on an empty panel is never checked', () => {
    expect(selectAllBox(run([{ type: 'toggleAll' }], loaded())).checked).toBe(false);
  });

  it('forgets a selected note that a reload no longer has', () => {
    const state = run(
      [
        { type: 'toggle', noteId: 'a' },
        { type: 'loaded', notes: [note('b')] },
      ],
      loaded('a', 'b')
    );
    expect(selectAllBox(state).label).toBe('Select all');
  });
});

describe('the draft form', () => {
  it('a new note starts empty and cannot be saved until both fields say something', () => {
    let state = run([{ type: 'newNote' }], loaded());
    expect(state.draft).toEqual({ noteId: null, title: '', content: '' });
    expect(canSave(state)).toBe(false);
    state = run([{ type: 'draftChanged', field: 'title', value: 'Escalation' }], state);
    expect(canSave(state)).toBe(false);
    state = run([{ type: 'draftChanged', field: 'content', value: '   ' }], state);
    expect(canSave(state)).toBe(false);
    state = run([{ type: 'draftChanged', field: 'content', value: 'Page the lead.' }], state);
    expect(canSave(state)).toBe(true);
  });

  it('a new note POSTs and an edited one PUTs to its own path', () => {
    expect(saveRequest({ noteId: null, title: 'T', content: 'C' })).toEqual({
      method: 'POST',
      path: '',
      body: { title: 'T', content: 'C' },
    });
    expect(saveRequest({ noteId: 'n1', title: 'T', content: 'C' })).toMatchObject({
      method: 'PUT',
      path: '/n1',
    });
  });

  it('editing fills the form from the note', () => {
    const state = run(
      [{ type: 'edit', note: note('a', { title: 'Old', content: 'Text' }) }],
      loaded('a')
    );
    expect(state.draft).toEqual({ noteId: 'a', title: 'Old', content: 'Text' });
  });

  it('nothing can be saved twice: Save is off while a request is out', () => {
    const state = run([{ type: 'edit', note: note('a') }, { type: 'sent' }], loaded('a'));
    expect(state.busy).toBe(true);
    expect(canSave(state)).toBe(false);
  });

  it('a saved draft closes; a refused one stays open with the reason', () => {
    const editing = run([{ type: 'edit', note: note('a') }, { type: 'sent' }], loaded('a'));
    expect(run([{ type: 'saved' }], editing).draft).toBeNull();
    const refused = run([{ type: 'failed', error: 'Title too long' }], editing);
    expect(refused.draft?.noteId).toBe('a');
    expect(refused).toMatchObject({ busy: false, error: 'Title too long' });
  });

  it('typing into no form changes nothing', () => {
    const state = loaded('a');
    expect(knowledgeReducer(state, { type: 'draftChanged', field: 'title', value: 'x' })).toBe(
      state
    );
  });
});

describe('deleting', () => {
  it('"Delete N" sends the selection; "Really delete all" sends all', () => {
    const state = run([{ type: 'toggle', noteId: 'b' }], loaded('a', 'b'));
    expect(bulkRemoval(state, false)).toEqual({ noteIds: ['b'] });
    expect(bulkRemoval(state, true)).toEqual({ all: true });
  });

  it('clear knowledge asks first, and "Keep them" stands it down', () => {
    const armed = run([{ type: 'armPurge' }], loaded('a'));
    expect(armed.purgeArmed).toBe(true);
    expect(run([{ type: 'disarmPurge' }], armed).purgeArmed).toBe(false);
  });

  it('a delete that went through disarms, and takes its notes out of the selection', () => {
    const state = run(
      [
        { type: 'toggle', noteId: 'a' },
        { type: 'toggle', noteId: 'b' },
        { type: 'armPurge' },
        { type: 'sent' },
        { type: 'removed', removal: { noteIds: ['a'] } },
      ],
      loaded('a', 'b')
    );
    expect(state).toMatchObject({ busy: false, purgeArmed: false });
    expect([...state.selected]).toEqual(['b']);
  });

  it('closes a draft that was editing a note just deleted, so it cannot be saved back', () => {
    const editing = run([{ type: 'edit', note: note('a') }], loaded('a', 'b'));
    expect(run([{ type: 'removed', removal: { noteIds: ['a'] } }], editing).draft).toBeNull();
    expect(run([{ type: 'removed', removal: { all: true } }], editing).draft).toBeNull();
    // Deleting another note leaves it, and so does deleting anything under a new note's draft.
    expect(run([{ type: 'removed', removal: { noteIds: ['b'] } }], editing).draft?.noteId).toBe(
      'a'
    );
    const fresh = run(
      [{ type: 'newNote' }, { type: 'removed', removal: { all: true } }],
      loaded('a')
    );
    expect(fresh.draft).not.toBeNull();
  });

  it('a refused delete keeps the selection and shows why', () => {
    const state = run(
      [
        { type: 'toggle', noteId: 'a' },
        { type: 'armPurge' },
        { type: 'sent' },
        { type: 'failed', error: 'Not your agent' },
      ],
      loaded('a')
    );
    expect(state).toMatchObject({ busy: false, purgeArmed: false, error: 'Not your agent' });
    expect([...state.selected]).toEqual(['a']);
  });
});

describe('preview', () => {
  it('shows a note whole up to 300 characters, and cuts a longer one with an ellipsis', () => {
    expect(preview('x'.repeat(300))).toHaveLength(300);
    const cut = preview('x'.repeat(301));
    expect(cut).toHaveLength(300);
    expect(cut.endsWith('…')).toBe(true);
  });
});
