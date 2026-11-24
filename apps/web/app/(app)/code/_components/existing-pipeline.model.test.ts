import {
  buildLabel,
  buildWarning,
  canCommit,
  commitRequest,
  existingReducer,
  fileOnScreen,
  filePath,
  fileUrl,
  initialExisting,
  isEdited,
  textRows,
  type ExistingAction,
  type ExistingState,
} from './existing-pipeline.model';

const run = (actions: ExistingAction[], from: ExistingState = initialExisting) =>
  actions.reduce(existingReducer, from);

const CI = 'name: CI\non: [push]\njobs: {}\n';
const opened = run([{ type: 'opened', files: ['ci.yml', 'deploy.yml'] }]);
const read = run([{ type: 'read', name: 'ci.yml', text: CI }], opened);
const editing = run([{ type: 'editStarted' }], read);
const changed = run(
  [{ type: 'draftChanged', field: 'text', value: `${CI}# and a cache\n` }],
  editing
);

describe('the branch’s own pipeline files', () => {
  it('open on the first, which is read from the branch', () => {
    expect(opened).toMatchObject({ selected: 'ci.yml', text: null, loading: true });
    expect(read).toMatchObject({ text: CI, loading: false });
    expect(fileOnScreen(opened)).toBeNull();
  });

  it('a branch with none has nothing open', () => {
    expect(run([{ type: 'opened', files: [] }])).toMatchObject({
      selected: null,
      loading: false,
    });
  });

  it('the file open stays open, with its edit, when the list is read again', () => {
    const again = run([{ type: 'opened', files: ['deploy.yml', 'ci.yml'] }], changed);
    expect(again.selected).toBe('ci.yml');
    expect(again.text).toBe(CI);
    expect(again.draft?.text).toContain('# and a cache');
  });

  it('a file gone from the branch gives way to the first that is there', () => {
    const gone = run([{ type: 'opened', files: ['deploy.yml'] }], changed);
    expect(gone).toMatchObject({ selected: 'deploy.yml', text: null, loading: true, draft: null });
  });

  it('picking another drops the edit under way and reads that one', () => {
    const picked = run([{ type: 'picked', name: 'deploy.yml' }], changed);
    expect(picked).toMatchObject({
      selected: 'deploy.yml',
      text: null,
      loading: true,
      draft: null,
    });
    // The one already open, or one the branch does not have, changes nothing.
    expect(run([{ type: 'picked', name: 'ci.yml' }], changed)).toBe(changed);
    expect(run([{ type: 'picked', name: 'nope.yml' }], changed)).toBe(changed);
  });

  it('an answer for a file no longer open is dropped', () => {
    const picked = run([{ type: 'picked', name: 'deploy.yml' }], read);
    expect(run([{ type: 'read', name: 'ci.yml', text: CI }], picked)).toBe(picked);
    expect(run([{ type: 'readFailed', name: 'ci.yml', error: 'gone' }], picked)).toBe(picked);
  });

  it('a read that fails says why', () => {
    expect(
      run([{ type: 'readFailed', name: 'ci.yml', error: 'Connect GitHub first.' }], opened)
    ).toMatchObject({
      loading: false,
      error: 'Connect GitHub first.',
    });
  });

  it('are named by where they live', () => {
    expect(filePath('github', 'ci.yml')).toBe('.github/workflows/ci.yml');
    expect(filePath('bitbucket', 'bitbucket-pipelines.yml')).toBe('bitbucket-pipelines.yml');
  });

  it('are read from and committed to the branch, on the Runs tab’s routes', () => {
    expect(fileUrl('github', 'p1', 'release/2.0', 'ci.yml')).toBe(
      '/api/code/projects/p1/actions/workflow-file?branch=release%2F2.0&name=ci.yml'
    );
    expect(fileUrl('bitbucket', 'p1', 'main', 'bitbucket-pipelines.yml')).toBe(
      '/api/code/projects/p1/pipelines/config-file?branch=main'
    );
  });
});

describe('editing the file', () => {
  it('starts from the branch’s text, with a commit message naming the file', () => {
    expect(editing.draft).toEqual({ text: CI, message: 'Update ci.yml' });
    // Not before the file is read, and not twice.
    expect(run([{ type: 'editStarted' }], opened).draft).toBeNull();
    expect(run([{ type: 'editStarted' }], changed)).toBe(changed);
  });

  it('can be committed only when the box differs, says something, and nothing is in flight', () => {
    expect(isEdited(editing)).toBe(false);
    expect(canCommit(editing)).toBe(false);
    expect(canCommit(changed)).toBe(true);
    const blank = run([{ type: 'draftChanged', field: 'text', value: '  \n' }], editing);
    expect(isEdited(blank)).toBe(true);
    expect(canCommit(blank)).toBe(false);
    expect(canCommit(run([{ type: 'sent' }], changed))).toBe(false);
    expect(canCommit(read)).toBe(false);
  });

  it('sends the box as it is and the message trimmed; GitHub is told which workflow', () => {
    const messaged = run(
      [{ type: 'draftChanged', field: 'message', value: '  Cache the dependencies ' }],
      changed
    );
    expect(commitRequest(messaged, 'github')).toEqual({
      name: 'ci.yml',
      text: `${CI}# and a cache\n`,
      message: 'Cache the dependencies',
    });
    expect(commitRequest(messaged, 'bitbucket')).toEqual({
      text: `${CI}# and a cache\n`,
      message: 'Cache the dependencies',
    });
  });

  it('a message left blank falls back to naming the file; no edit sends nothing', () => {
    const blank = run([{ type: 'draftChanged', field: 'message', value: '   ' }], changed);
    expect(commitRequest(blank, 'bitbucket')?.message).toBe('Update ci.yml');
    expect(commitRequest(read, 'github')).toBeNull();
  });

  it('once committed, the branch’s text is what was committed and the editor closes', () => {
    const committed = run(
      [
        { type: 'sent' },
        { type: 'committed', ref: 'main', url: 'https://github.com/a/b/blob/main/ci.yml' },
      ],
      changed
    );
    expect(committed).toMatchObject({
      busy: false,
      draft: null,
      text: `${CI}# and a cache\n`,
      committed: { ref: 'main', url: 'https://github.com/a/b/blob/main/ci.yml' },
    });
    // Editing again starts from it, and the last commit's line goes.
    const again = run([{ type: 'editStarted' }], committed);
    expect(again.draft?.text).toBe(`${CI}# and a cache\n`);
    expect(again.committed).toBeNull();
  });

  it('a refused commit says why and keeps what was typed', () => {
    const failed = run(
      [{ type: 'sent' }, { type: 'failed', error: 'The branch is protected.' }],
      changed
    );
    expect(failed).toMatchObject({ busy: false, error: 'The branch is protected.' });
    expect(failed.draft?.text).toContain('# and a cache');
    expect(canCommit(failed)).toBe(true);
  });

  it('cancelling leaves the file as the branch has it', () => {
    const cancelled = run([{ type: 'editCancelled' }], changed);
    expect(cancelled.draft).toBeNull();
    expect(cancelled.text).toBe(CI);
  });

  it('the box grows with the file, within bounds', () => {
    expect(textRows('a')).toBe(10);
    expect(textRows('a\n'.repeat(20))).toBe(22);
    expect(textRows('a\n'.repeat(200))).toBe(32);
  });
});

describe('the assistant’s file', () => {
  const proposal = 'name: CI\non: [push, pull_request]\njobs: {}\n';

  it('goes into the editor to be looked over: nothing is committed by taking it', () => {
    const applied = run([{ type: 'proposalApplied', name: 'ci.yml', text: proposal }], read);
    expect(applied.draft).toEqual({ text: proposal, message: 'Update ci.yml' });
    expect(applied.text).toBe(CI);
    expect(applied.busy).toBe(false);
    expect(canCommit(applied)).toBe(true);
  });

  it('replaces the box of an edit under way and keeps the commit message typed', () => {
    const messaged = run(
      [{ type: 'draftChanged', field: 'message', value: 'Run on pull requests too' }],
      changed
    );
    const applied = run([{ type: 'proposalApplied', name: 'ci.yml', text: proposal }], messaged);
    expect(applied.draft).toEqual({ text: proposal, message: 'Run on pull requests too' });
  });

  it('is ignored when it is for another file than the one open', () => {
    expect(run([{ type: 'proposalApplied', name: 'deploy.yml', text: proposal }], read)).toBe(read);
  });

  it('is asked about what the editor has now: the edit under way, else the file as it is', () => {
    expect(fileOnScreen(read)).toEqual({ name: 'ci.yml', text: CI });
    expect(fileOnScreen(changed)).toEqual({ name: 'ci.yml', text: `${CI}# and a cache\n` });
  });
});

describe('building from blocks instead', () => {
  it('on Bitbucket replaces the file, and says so before it is chosen', () => {
    expect(buildLabel('bitbucket')).toBe('Replace it with one built from blocks');
    expect(buildWarning('bitbucket', { files: ['bitbucket-pipelines.yml'] }, 'main')).toBe(
      'The builder writes the whole of bitbucket-pipelines.yml, in a pull request against main: merging it replaces the file here. The pull request’s diff shows what changes.'
    );
  });

  it('on GitHub adds a workflow beside the ones there, which still run', () => {
    expect(buildLabel('github')).toBe('Add a workflow built from blocks');
    expect(buildWarning('github', { files: ['ci.yml'] }, 'develop')).toBe(
      'The builder writes its own workflow, .github/workflows/pipeline.yml, in a pull request against develop. The workflow here stays and still runs, so remove what the new one takes over.'
    );
    expect(buildWarning('github', { files: ['ci.yml', 'deploy.yml'] }, 'develop')).toBe(
      'The builder writes its own workflow, .github/workflows/pipeline.yml, in a pull request against develop. The workflows here stay and still run, so remove what the new one takes over.'
    );
  });

  it('on GitHub replaces a pipeline.yml written by hand, and only that', () => {
    expect(buildWarning('github', { files: ['ci.yml', 'pipeline.yml'] }, 'main')).toBe(
      'The builder writes its own workflow, .github/workflows/pipeline.yml, in a pull request against main. That replaces the pipeline.yml here; the other workflows stay and still run.'
    );
  });
});

describe('the report step', () => {
  const step = {
    snippet: '- step:\n    deployment: dev\n',
    where: 'A step for bitbucket-pipelines.yml.',
    environment: 'dev',
  };

  it('is asked for, then shown to be copied', () => {
    const asked = run([{ type: 'reportAsked' }], read);
    expect(asked).toMatchObject({ reportBusy: true, reportError: null, report: null });
    const shown = run([{ type: 'reportRead', step }], asked);
    expect(shown).toMatchObject({ reportBusy: false, report: step, copied: false });
    expect(run([{ type: 'copied' }], shown).copied).toBe(true);
  });

  it('a refusal says why, and asking again clears it', () => {
    const failed = run(
      [
        { type: 'reportAsked' },
        { type: 'reportFailed', error: 'Renkei does not know its own address here.' },
      ],
      read
    );
    expect(failed).toMatchObject({
      reportBusy: false,
      report: null,
      reportError: 'Renkei does not know its own address here.',
    });
    expect(run([{ type: 'reportAsked' }], failed).reportError).toBeNull();
  });

  it('copying it says so', () => {
    const copied = run([{ type: 'reportRead', step }, { type: 'copied' }], read);
    expect(copied.copied).toBe(true);
  });

  it('leaves the file and its edit alone', () => {
    const shown = run([{ type: 'reportAsked' }, { type: 'reportRead', step }], changed);
    expect(shown.draft).toEqual(changed.draft);
    expect(shown.selected).toBe('ci.yml');
  });
});
