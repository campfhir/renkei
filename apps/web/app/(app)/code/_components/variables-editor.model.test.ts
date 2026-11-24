import {
  canSave,
  changeSummary,
  changes,
  editorReducer,
  fileProblem,
  importedLine,
  initialEditor,
  isDirty,
  outcomeLines,
  removalQuestion,
  rowProblem,
  rowState,
  saveRequest,
  valuePlaceholder,
  type EditorAction,
  type EditorState,
  type ListedVariable,
} from './variables-editor.model';

const HOST: ListedVariable[] = [
  { key: 'API_BASE_URL', value: 'https://api.example.test', secured: false },
  { key: 'DEPLOY_TOKEN', value: null, secured: true },
  { key: 'REGION', value: 'eu-west-1', secured: false },
];

function after(...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, initialEditor);
}
const loaded = (variables = HOST): EditorAction => ({ type: 'loaded', variables });
const row = (state: EditorState, key: string) => state.rows.find((r) => r.key === key)!;
const idOf = (state: EditorState, key: string) => row(state, key).id;

describe('the set as the host has it', () => {
  it('is rows: plain ones with their values, a secret with none to show', () => {
    const state = after(loaded());
    expect(state.rows.map((r) => [r.key, r.value, r.secured])).toEqual([
      ['API_BASE_URL', 'https://api.example.test', false],
      ['DEPLOY_TOKEN', '', true],
      ['REGION', 'eu-west-1', false],
    ]);
    expect(isDirty(state)).toBe(false);
    expect(canSave(state)).toBe(false);
    expect(changeSummary(state)).toBeNull();
  });

  it('a saved secret says its value is kept until one is typed', () => {
    const state = after(loaded());
    expect(valuePlaceholder(row(state, 'DEPLOY_TOKEN'))).toBe('Secret — type to replace');
    expect(valuePlaceholder(row(state, 'REGION'))).toBe('Value');
  });

  it('a read that lands on unsaved edits does not take them away', () => {
    const edited = after(loaded(), { type: 'fileRead', name: '.env', text: 'NEW=1' });
    const again = editorReducer(edited, loaded([]));
    expect(again.rows).toHaveLength(4);
    // With nothing typed, the newer read is what shows.
    expect(editorReducer(after(loaded()), loaded([])).rows).toHaveLength(0);
  });
});

describe('a .env file, read in the browser', () => {
  const file = [
    '# the dev stack',
    'API_BASE_URL=https://api.dev.example.test',
    'REGION=eu-west-1',
    'export NPM_TOKEN="npm_abc 123"',
    'FEATURE_FLAGS=a,b',
    'not a line',
  ].join('\n');

  it('fills the rows: a new name is a new row, a name already there takes the value', () => {
    const state = after(loaded(), { type: 'fileRead', name: 'dev.env', text: file });
    expect(row(state, 'API_BASE_URL').value).toBe('https://api.dev.example.test');
    expect(rowState(row(state, 'API_BASE_URL'))).toBe('changed');
    expect(rowState(row(state, 'REGION'))).toBe('same');
    expect(row(state, 'NPM_TOKEN')).toMatchObject({ value: 'npm_abc 123', original: null });
    expect(rowState(row(state, 'FEATURE_FLAGS'))).toBe('new');
    // What the file does not name is left as it is: nothing is removed.
    expect(rowState(row(state, 'DEPLOY_TOKEN'))).toBe('same');
  });

  it('says what it brought, and which lines were not variables', () => {
    const state = after(loaded(), { type: 'fileRead', name: 'dev.env', text: file });
    expect(importedLine(state)).toBe(
      'Read 4 variables from dev.env: 2 new, 1 changed, 1 already as saved. Lock the ones that are secrets, then save.'
    );
    expect(state.problems).toEqual(['line 6: not a NAME=value line']);
  });

  it('locks a new name that reads as a secret, and leaves the rest plain to be locked by hand', () => {
    const state = after(loaded(), { type: 'fileRead', name: 'dev.env', text: file });
    expect(row(state, 'NPM_TOKEN').secured).toBe(true);
    expect(row(state, 'FEATURE_FLAGS').secured).toBe(false);
    const locked = editorReducer(state, {
      type: 'lockToggled',
      id: idOf(state, 'FEATURE_FLAGS'),
    });
    expect(row(locked, 'FEATURE_FLAGS').secured).toBe(true);
    // And a lock put on by the name can be taken off again before saving.
    const unlocked = editorReducer(locked, { type: 'lockToggled', id: idOf(locked, 'NPM_TOKEN') });
    expect(row(unlocked, 'NPM_TOKEN').secured).toBe(false);
  });

  it('sends nothing by being read: only Save does, with the rows as they then stand', () => {
    const state = after(loaded(), { type: 'fileRead', name: 'dev.env', text: file });
    expect(state.busy).toBe(false);
    expect(saveRequest(state, 'dev')).toEqual({
      scope: 'environment',
      environment: 'dev',
      set: [
        { key: 'API_BASE_URL', value: 'https://api.dev.example.test', secured: false },
        { key: 'NPM_TOKEN', value: 'npm_abc 123', secured: true },
        { key: 'FEATURE_FLAGS', value: 'a,b', secured: false },
      ],
      remove: [],
    });
  });

  it('a value for a saved secret replaces it, still locked', () => {
    const state = after(loaded(), {
      type: 'fileRead',
      name: '.env',
      text: 'DEPLOY_TOKEN=new-token',
    });
    expect(changes(state).set).toEqual([
      { key: 'DEPLOY_TOKEN', value: 'new-token', secured: true },
    ]);
  });

  it('a file with no variables says so', () => {
    const state = after(loaded(), { type: 'fileRead', name: 'notes.txt', text: '# nothing\n' });
    expect(importedLine(state)).toBe('No variables were found in notes.txt.');
    expect(isDirty(state)).toBe(false);
  });

  it('a name that is not a variable name is reported, not added', () => {
    const state = after(loaded([]), {
      type: 'fileRead',
      name: '.env',
      text: `${'A'.repeat(200)}=1`,
    });
    expect(state.rows).toHaveLength(0);
    expect(state.problems[0]).toMatch(/is not a variable name$/);
  });

  it('is refused when it is too large to be one', () => {
    expect(fileProblem({ name: 'dump.sql', size: 5_000_000 })).toBe(
      'dump.sql is too large to be an environment file (over 256 KB).'
    );
    expect(fileProblem({ name: '.env', size: 900 })).toBeNull();
  });

  it('pasted text is read the same way, when the box is applied', () => {
    const opened = after(loaded([]), { type: 'pasteOpened' });
    expect(opened.paste).toBe('');
    const typed = editorReducer(opened, { type: 'pasteChanged', text: 'A=1\nB=2' });
    expect(typed.rows).toHaveLength(0);
    const applied = editorReducer(typed, { type: 'pasteApplied' });
    expect(applied.rows.map((r) => r.key)).toEqual(['A', 'B']);
    expect(applied.paste).toBeNull();
    expect(importedLine(applied)).toContain('from what you pasted');
    expect(editorReducer(opened, { type: 'pasteCancelled' }).paste).toBeNull();
  });
});

describe('editing by hand', () => {
  it('a new row is named and valued; a saved one keeps its name', () => {
    let state = after(loaded(), { type: 'rowAdded' });
    const id = state.rows.at(-1)!.id;
    state = editorReducer(state, { type: 'rowChanged', id, field: 'key', value: 'TIMEOUT' });
    state = editorReducer(state, { type: 'rowChanged', id, field: 'value', value: '30' });
    state = editorReducer(state, {
      type: 'rowChanged',
      id: idOf(state, 'REGION'),
      field: 'key',
      value: 'ZONE',
    });
    expect(row(state, 'REGION')).toBeDefined();
    expect(changes(state)).toEqual({
      set: [{ key: 'TIMEOUT', value: '30', secured: false }],
      remove: [],
    });
    expect(changeSummary(state)).toBe('1 to add');
  });

  it('an empty new row is left alone by Save', () => {
    const state = after(loaded(), { type: 'rowAdded' });
    expect(isDirty(state)).toBe(false);
    expect(canSave(state)).toBe(false);
  });

  it('locking a plain variable saves its value as a secret', () => {
    const state = after(loaded());
    const locked = editorReducer(state, { type: 'lockToggled', id: idOf(state, 'REGION') });
    expect(rowState(row(locked, 'REGION'))).toBe('changed');
    expect(changes(locked).set).toEqual([{ key: 'REGION', value: 'eu-west-1', secured: true }]);
  });

  it('unlocking a saved secret needs its value typed again: it cannot be read back', () => {
    const state = after(loaded());
    const unlocked = editorReducer(state, { type: 'lockToggled', id: idOf(state, 'DEPLOY_TOKEN') });
    expect(rowProblem(row(unlocked, 'DEPLOY_TOKEN'), unlocked.rows)).toBe(
      'Its value cannot be read back: type it to make it plain.'
    );
    expect(canSave(unlocked)).toBe(false);
    const typed = editorReducer(unlocked, {
      type: 'rowChanged',
      id: idOf(unlocked, 'DEPLOY_TOKEN'),
      field: 'value',
      value: 'shown-now',
    });
    expect(canSave(typed)).toBe(true);
    expect(changes(typed).set).toEqual([
      { key: 'DEPLOY_TOKEN', value: 'shown-now', secured: false },
    ]);
  });

  it('a new row needs a usable name, once, and a secret needs a value', () => {
    let state = after(loaded(), { type: 'rowAdded' });
    const id = state.rows.at(-1)!.id;
    state = editorReducer(state, { type: 'rowChanged', id, field: 'value', value: 'x' });
    expect(rowProblem(state.rows.at(-1)!, state.rows)).toBe('Give it a name.');
    state = editorReducer(state, { type: 'rowChanged', id, field: 'key', value: '1BAD' });
    expect(rowProblem(state.rows.at(-1)!, state.rows)).toBe(
      'Letters, digits and underscores, not starting with a digit.'
    );
    state = editorReducer(state, { type: 'rowChanged', id, field: 'key', value: 'REGION' });
    expect(rowProblem(state.rows.at(-1)!, state.rows)).toBe('REGION is here twice.');
    state = editorReducer(state, { type: 'rowChanged', id, field: 'key', value: 'NEW_KEY' });
    state = editorReducer(state, { type: 'rowChanged', id, field: 'value', value: '' });
    state = editorReducer(state, { type: 'lockToggled', id });
    expect(rowProblem(state.rows.at(-1)!, state.rows)).toBe('A secret needs a value.');
    expect(canSave(state)).toBe(false);
  });

  it('a saved row is marked to go and can be kept again; a new one is just dropped', () => {
    let state = after(loaded(), { type: 'rowAdded' });
    const fresh = state.rows.at(-1)!.id;
    state = editorReducer(state, { type: 'removeToggled', id: fresh });
    expect(state.rows).toHaveLength(3);
    state = editorReducer(state, { type: 'removeToggled', id: idOf(state, 'REGION') });
    expect(rowState(row(state, 'REGION'))).toBe('removed');
    expect(changes(state)).toEqual({ set: [], remove: ['REGION'] });
    expect(removalQuestion(state)).toBe('Remove REGION? Pipeline runs will no longer see it.');
    state = editorReducer(state, { type: 'removeToggled', id: idOf(state, 'REGION') });
    expect(isDirty(state)).toBe(false);
    expect(removalQuestion(state)).toBeNull();
  });

  it('discarding puts every row back as the host has it', () => {
    let state = after(loaded(), { type: 'fileRead', name: '.env', text: 'A=1\nREGION=us' });
    state = editorReducer(state, { type: 'lockToggled', id: idOf(state, 'API_BASE_URL') });
    state = editorReducer(state, { type: 'discarded' });
    expect(state.rows.map((r) => r.key)).toEqual(['API_BASE_URL', 'DEPLOY_TOKEN', 'REGION']);
    expect(isDirty(state)).toBe(false);
    expect(importedLine(state)).toBeNull();
  });

  it('the summary counts what the save will do', () => {
    let state = after(loaded(), { type: 'fileRead', name: '.env', text: 'A=1\nREGION=us' });
    state = editorReducer(state, { type: 'removeToggled', id: idOf(state, 'API_BASE_URL') });
    expect(changeSummary(state)).toBe('1 to add · 1 to change · 1 to remove');
  });
});

describe('Save', () => {
  it('names the repository’s set, or the environment’s', () => {
    const state = after(loaded([]), { type: 'fileRead', name: '.env', text: 'A=1' });
    expect(saveRequest(state, null)).toEqual({
      scope: 'repository',
      set: [{ key: 'A', value: '1', secured: false }],
      remove: [],
    });
    expect(saveRequest(state, 'dev')).toMatchObject({ scope: 'environment', environment: 'dev' });
  });

  it('is busy while it is out, and a refusal leaves the rows as typed', () => {
    const typed = after(loaded([]), { type: 'fileRead', name: '.env', text: 'A=1' });
    const sent = editorReducer(typed, { type: 'sent' });
    expect(canSave(sent)).toBe(false);
    const failed = editorReducer(sent, { type: 'failed', error: 'Connect GitHub first.' });
    expect(failed.error).toBe('Connect GitHub first.');
    expect(row(failed, 'A').value).toBe('1');
    expect(canSave(failed)).toBe(true);
  });

  it('once through, the rows are the host’s again and a secret’s value is gone from the page', () => {
    let state = after(loaded([]), {
      type: 'fileRead',
      name: '.env',
      text: 'A=1\nAPI_TOKEN=tok-123',
    });
    state = editorReducer(state, { type: 'sent' });
    state = editorReducer(state, {
      type: 'saved',
      outcome: { added: ['A', 'API_TOKEN'], changed: [], removed: [], errors: [] },
      variables: [
        { key: 'A', value: '1', secured: false },
        { key: 'API_TOKEN', value: null, secured: true },
      ],
    });
    expect(row(state, 'API_TOKEN')).toMatchObject({ value: '', secured: true });
    expect(JSON.stringify(state)).not.toContain('tok-123');
    expect(isDirty(state)).toBe(false);
    expect(outcomeLines(state.outcome!)).toEqual({
      status: 'Saved: added A, API_TOKEN.',
      refused: null,
    });
  });

  it('what the host refused stays as typed, to be fixed and saved again', () => {
    let state = after(loaded(), { type: 'fileRead', name: '.env', text: 'GITHUB_X=1\nREGION=us' });
    state = editorReducer(state, { type: 'sent' });
    state = editorReducer(state, {
      type: 'saved',
      outcome: {
        added: [],
        changed: ['REGION'],
        removed: [],
        errors: ['GITHUB_X is not allowed: letters, digits and underscores.'],
      },
      variables: [...HOST.slice(0, 2), { key: 'REGION', value: 'us', secured: false }],
    });
    expect(row(state, 'REGION').value).toBe('us');
    expect(rowState(row(state, 'REGION'))).toBe('same');
    expect(outcomeLines(state.outcome!)).toEqual({
      status: 'Saved: changed REGION.',
      refused: 'Not saved: GITHUB_X is not allowed: letters, digits and underscores.',
    });
  });

  it('a save that changed nothing says so', () => {
    expect(outcomeLines({ added: [], changed: [], removed: [], errors: [] })).toEqual({
      status: 'Nothing changed.',
      refused: null,
    });
  });
});

describe('sent here to set one variable (the builder’s “Set it”)', () => {
  it('adds its row, locked when it is a secret, with the cursor in its value', () => {
    const state = after(loaded(), { type: 'asked', name: 'SIGNING_KEY', secured: true });
    const asked = row(state, 'SIGNING_KEY');
    expect(asked).toMatchObject({ value: '', secured: true, original: null });
    expect(state.focus).toBe(asked.id);
    // Nothing to save until a value is typed.
    expect(canSave(state)).toBe(false);
  });

  it('a variable already there takes the cursor instead', () => {
    const state = after(loaded(), { type: 'asked', name: 'REGION', secured: false });
    expect(state.rows).toHaveLength(3);
    expect(state.focus).toBe(idOf(state, 'REGION'));
  });
});
