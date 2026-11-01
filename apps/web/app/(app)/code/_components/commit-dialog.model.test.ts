/**
 * The code pane's Commit dialog (commit-dialog.model.ts), as a person
 * using it would describe it. code.spec.ts keeps one commit and one push
 * made for real from the pane, and their notes in the chat.
 */

import {
  askLabel,
  commitButton,
  commitReducer,
  commitRequest,
  filesHeading,
  initialCommit,
  selectedTotals,
  unsavedNotice,
  whoTag,
  type ChangedRow,
  type CommitAction,
  type CommitState,
} from './commit-dialog.model';

const row = (path: string, added = 1, deleted = 0): ChangedRow => ({
  path,
  status: 'modified',
  added,
  deleted,
});

const files = [row('src/billing.ts', 3, 1), row('README.md', 2, 2), row('new.txt', 5, 0)];

const run = (actions: CommitAction[], from: CommitState = initialCommit(files)) =>
  actions.reduce(commitReducer, from);

describe('the files', () => {
  it('opens with every changed file ticked, counted and totalled', () => {
    const state = initialCommit(files);
    expect(filesHeading(state, files)).toBe('Files · 3 of 3 selected');
    expect(selectedTotals(state, files)).toEqual({ added: 10, deleted: 3 });
    expect(commitButton(state)).toEqual({ label: 'Commit 3 files', disabled: false });
  });

  it('unticking a file takes it out of the count and the totals', () => {
    const state = run([{ type: 'toggle', path: 'new.txt', on: false }]);
    expect(filesHeading(state, files)).toBe('Files · 2 of 3 selected');
    expect(selectedTotals(state, files)).toEqual({ added: 5, deleted: 3 });
  });

  it('None turns Commit off; All ticks everything again', () => {
    const none = run([{ type: 'none' }]);
    expect(commitButton(none)).toEqual({ label: 'Commit 0 files', disabled: true });
    expect(run([{ type: 'all', files }], none).selected.size).toBe(3);
  });

  it('one file says “file”', () => {
    expect(commitButton(initialCommit([row('a')])).label).toBe('Commit 1 file');
  });

  it('a file saved while the dialog is open turns up ticked', () => {
    const state = run([{ type: 'changed', files: [...files, row('src/util.ts')] }]);
    expect(state.selected.has('src/util.ts')).toBe(true);
  });

  it('a file unticked stays unticked when the list refreshes', () => {
    const state = run([
      { type: 'toggle', path: 'README.md', on: false },
      { type: 'changed', files: [...files] },
      { type: 'changed', files: [...files, row('src/util.ts')] },
    ]);
    expect(state.selected.has('README.md')).toBe(false);
    expect(state.selected.has('src/util.ts')).toBe(true);
  });

  it('a file no longer changed drops off', () => {
    const state = run([{ type: 'changed', files: [files[0]!] }]);
    expect([...state.selected]).toEqual(['src/billing.ts']);
  });

  it('a file that went clean and changed again comes back ticked', () => {
    const state = run([
      { type: 'toggle', path: 'README.md', on: false },
      { type: 'changed', files: [files[0]!] },
      { type: 'changed', files },
    ]);
    expect(state.selected.has('README.md')).toBe(true);
  });

  it('the diff button unfolds one file’s diff, and folds it again', () => {
    const open = run([{ type: 'diff', path: 'README.md' }]);
    expect(open.diffOpen).toBe('README.md');
    expect(run([{ type: 'diff', path: 'README.md' }], open).diffOpen).toBeNull();
    expect(run([{ type: 'diff', path: 'new.txt' }], open).diffOpen).toBe('new.txt');
  });

  it('tags what this browser saved, else what the chat wrote, else nothing', () => {
    const here = new Set(['src/billing.ts']);
    const chat = new Set(['src/billing.ts', 'README.md']);
    expect(whoTag('src/billing.ts', here, chat)).toBe('edited here');
    expect(whoTag('README.md', here, chat)).toBe('by the chat');
    expect(whoTag('new.txt', here, chat)).toBeNull();
  });

  it('warns that unsaved edits are not part of the commit', () => {
    expect(unsavedNotice([])).toBeNull();
    expect(unsavedNotice(['a'])).toBe('1 file has unsaved edits, which are not part of a commit.');
    expect(unsavedNotice(['a', 'b'])).toBe(
      '2 files have unsaved edits, which are not part of a commit.'
    );
  });
});

describe('what Commit sends', () => {
  it('needs a message', () => {
    expect(commitRequest(run([{ type: 'subject', value: '   ' }]), files)).toEqual({
      ok: false,
      error: 'Write a commit message.',
    });
  });

  it('needs a file', () => {
    expect(
      commitRequest(run([{ type: 'subject', value: 'Fix' }, { type: 'none' }]), files)
    ).toEqual({ ok: false, error: 'Pick at least one file.' });
  });

  it('needs the new branch named when it makes one', () => {
    const state = run([
      { type: 'subject', value: 'Fix' },
      { type: 'newBranch', on: true },
      { type: 'branchName', value: ' ' },
    ]);
    expect(commitRequest(state, files)).toEqual({ ok: false, error: 'Name the new branch.' });
  });

  it('every file ticked commits the tree, with the description under the message', () => {
    const state = run([
      { type: 'subject', value: ' Note the manual review ' },
      { type: 'body', value: ' A comment for the next reader. ' },
    ]);
    expect(commitRequest(state, files)).toEqual({
      ok: true,
      body: { message: 'Note the manual review\n\nA comment for the next reader.' },
    });
  });

  it('some files ticked commits those paths, on a new branch when asked', () => {
    const state = run([
      { type: 'subject', value: 'Fix' },
      { type: 'toggle', path: 'new.txt', on: false },
      { type: 'newBranch', on: true },
      { type: 'branchName', value: ' feature/x ' },
    ]);
    expect(commitRequest(state, files)).toEqual({
      ok: true,
      body: { message: 'Fix', paths: ['src/billing.ts', 'README.md'], newBranch: 'feature/x' },
    });
  });

  it('a branch name typed and then unchecked is not sent', () => {
    const state = run([
      { type: 'subject', value: 'Fix' },
      { type: 'newBranch', on: true },
      { type: 'branchName', value: 'feature/x' },
      { type: 'newBranch', on: false },
    ]);
    expect(commitRequest(state, files)).toEqual({ ok: true, body: { message: 'Fix' } });
  });
});

describe('after the commit', () => {
  const committed = run([
    { type: 'sent' },
    { type: 'committed', commit: { branch: 'renkei/x', sha: 'c0ffee', subject: 'Fix' } },
  ]);

  it('shows the hash, not yet pushed, and offers to have the chat push and open a PR', () => {
    expect(committed.committed?.sha).toBe('c0ffee');
    expect(committed.pushed).toBeNull();
    expect(askLabel(committed)).toBe('Ask the chat to push and open a pull request');
  });

  it('once pushed, the ask is only for the pull request', () => {
    const pushed = run([{ type: 'sent' }, { type: 'pushed', remoteBranch: 'renkei/x' }], committed);
    expect(pushed.pushed).toEqual({ remoteBranch: 'renkei/x' });
    expect(askLabel(pushed)).toBe('Ask the chat to open a pull request');
  });

  it('a refused commit or push says why and lets it be tried again', () => {
    const failed = run(
      [{ type: 'sent' }, { type: 'failed', error: 'The push failed.' }],
      committed
    );
    expect(failed).toMatchObject({ busy: false, error: 'The push failed.' });
    expect(run([{ type: 'sent' }], failed).error).toBeNull();
    const busy = run([{ type: 'sent' }]);
    expect(commitButton(busy)).toEqual({ label: 'Committing…', disabled: true });
  });
});
