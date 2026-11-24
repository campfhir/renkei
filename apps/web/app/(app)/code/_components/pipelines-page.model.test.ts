/**
 * A branch's Bitbucket Pipelines runs (pipelines-page.model.ts, the Runs
 * tab of a branch on the Environments page), as a person using it would
 * describe it. The browser spec (code-pipelines.spec.ts) keeps the page
 * rendering what the Bitbucket stand-in answers, one press through each
 * kind of change, and the phone width. Variables are the Variables tab's
 * (variables-editor.model.test.ts).
 */

import type { PipelineRun } from '@/lib/code/bitbucket-pipelines';
import {
  branchLabel,
  canCommit,
  canRun,
  canStartRun,
  committedReminder,
  duration,
  fileRequest,
  initialPipelines,
  pipelinesReducer,
  pipelinesUrl,
  runRequest,
  runStatePill,
  textRows,
  type PipelinesAction,
  type PipelinesState,
  type Setup,
} from './pipelines-page.model';

const setup = (more: Partial<Setup> = {}): Setup => ({
  enabled: false,
  enabledError: null,
  configFile: 'absent',
  runs: [],
  runsError: null,
  variables: [],
  variablesError: null,
  environments: [],
  environmentsError: null,
  access: { configureNeeds: null, variablesNeeds: null },
  ...more,
});

const run = (actions: PipelinesAction[], from: PipelinesState = initialPipelines) =>
  actions.reduce(pipelinesReducer, from);

const opened = (more: Partial<Setup> = {}) => run([{ type: 'loaded', setup: setup(more) }]);

const pipelineRun = (more: Partial<PipelineRun> = {}): PipelineRun => ({
  uuid: '{r3}',
  buildNumber: 3,
  state: 'PENDING',
  ref: 'main',
  startedBy: 'E2E Dev',
  createdOn: '2026-11-01T00:00:00Z',
  durationSeconds: null,
  url: 'https://bitbucket.org/acme/demo/pipelines/results/3',
  ...more,
});

describe('reading the page', () => {
  it('knows nothing until Bitbucket answers, then shows the setup', () => {
    expect(initialPipelines.setup).toBeNull();
    expect(opened().setup?.enabled).toBe(false);
  });

  it('shows a failed read, and clears it on the next good one', () => {
    const failed = run([{ type: 'loadFailed', error: 'Bitbucket is not connected.' }]);
    expect(failed.loadError).toBe('Bitbucket is not connected.');
    expect(run([{ type: 'loaded', setup: setup() }], failed).loadError).toBeNull();
  });

  it('links the repository’s Pipelines on bitbucket.org, and nothing for a name it cannot split', () => {
    expect(pipelinesUrl('acme/pipelines-demo')).toBe(
      'https://bitbucket.org/acme/pipelines-demo/pipelines'
    );
    expect(pipelinesUrl('just-a-name')).toBeNull();
  });

  it('names the project’s branch, or the default one when it has none', () => {
    expect(branchLabel('main')).toBe('main');
    expect(branchLabel('')).toBe('the default branch');
  });
});

describe('the switch', () => {
  it('turning it on is busy until the setup is read again, and a refusal says why', () => {
    const sending = run([{ type: 'sent', what: 'flip' }], opened());
    expect(sending.busy).toBe(true);
    expect(run([{ type: 'flipped' }], sending).busy).toBe(false);
    const refused = run([{ type: 'failed', error: 'Needs repository:admin' }], sending);
    expect(refused).toMatchObject({ busy: false, error: 'Needs repository:admin' });
    expect(run([{ type: 'sent', what: 'flip' }], refused).error).toBeNull();
  });
});

describe('starting a run', () => {
  it('is offered to an editor unless Pipelines is known to be off', () => {
    expect(canRun(opened({ enabled: true }), true)).toBe(true);
    expect(canRun(opened({ enabled: null }), true)).toBe(true);
    expect(canRun(opened({ enabled: false }), true)).toBe(false);
    expect(canRun(opened({ enabled: true }), false)).toBe(false);
    expect(canRun(initialPipelines, true)).toBe(false);
  });

  it('opens on the project’s branch, as a branch, with the ref’s default pipeline', () => {
    const state = run([{ type: 'runOpened', defaultRef: 'main' }], opened({ enabled: true }));
    expect(state.runDraft).toEqual({ ref: 'main', refType: 'branch', pattern: '' });
  });

  it('cannot start without a branch or tag, nor while something is in flight', () => {
    const open = run([{ type: 'runOpened', defaultRef: 'main' }], opened({ enabled: true }));
    expect(canStartRun(open)).toBe(true);
    expect(canStartRun(run([{ type: 'runChanged', field: 'ref', value: '   ' }], open))).toBe(
      false
    );
    expect(canStartRun(run([{ type: 'sent', what: 'flip' }], open))).toBe(false);
  });

  it('sends the ref and custom pipeline trimmed, and the type only as branch or tag', () => {
    const state = run(
      [
        { type: 'runOpened', defaultRef: 'main' },
        { type: 'runChanged', field: 'ref', value: ' v1.2 ' },
        { type: 'runTypeChanged', value: 'tag' },
        { type: 'runChanged', field: 'pattern', value: ' deploy ' },
      ],
      opened({ enabled: true })
    );
    expect(runRequest(state.runDraft!)).toEqual({ ref: 'v1.2', refType: 'tag', pattern: 'deploy' });
    expect(run([{ type: 'runTypeChanged', value: 'anything' }], state).runDraft?.refType).toBe(
      'branch'
    );
  });

  it('a started run closes the form and is named until the next start', () => {
    const started = run(
      [
        { type: 'runOpened', defaultRef: 'main' },
        { type: 'sent', what: 'run' },
        { type: 'runStarted', run: pipelineRun() },
      ],
      opened({ enabled: true })
    );
    expect(started.runDraft).toBeNull();
    expect(started.started?.buildNumber).toBe(3);
    expect(run([{ type: 'sent', what: 'run' }], started).started).toBeNull();
    // Another kind of change leaves it named.
    expect(run([{ type: 'sent', what: 'flip' }], started).started?.buildNumber).toBe(3);
  });

  it('a refused run keeps the form as it was, with the reason', () => {
    const refused = run(
      [
        { type: 'runOpened', defaultRef: 'main' },
        { type: 'runChanged', field: 'pattern', value: 'nope' },
        { type: 'sent', what: 'run' },
        { type: 'failed', error: 'No custom pipeline named nope' },
      ],
      opened({ enabled: true })
    );
    expect(refused.runDraft?.pattern).toBe('nope');
    expect(refused.error).toBe('No custom pipeline named nope');
  });
});

describe('a run in the list', () => {
  it('reads its state in sentence case, coloured by how it went', () => {
    expect(runStatePill('SUCCESSFUL')).toEqual({ tone: 'green', label: 'Successful' });
    expect(runStatePill('FAILED')).toEqual({ tone: 'red', label: 'Failed' });
    expect(runStatePill('IN_PROGRESS')).toEqual({ tone: 'blue', label: 'In progress' });
    expect(runStatePill('PENDING')).toEqual({ tone: 'blue', label: 'Pending' });
    expect(runStatePill('STOPPED')).toEqual({ tone: 'gray', label: 'Stopped' });
    expect(runStatePill('')).toEqual({ tone: 'gray', label: 'Unknown' });
  });

  it('says how long it took at a readable coarseness', () => {
    expect(duration(45)).toBe('45s');
    expect(duration(312)).toBe('5m 12s');
    expect(duration(7380)).toBe('2h 3m');
  });
});

describe('the pipeline file', () => {
  it('opens empty with an "Add" message when the branch has none', () => {
    const state = run([{ type: 'fileOpening' }, { type: 'fileOpened', text: null }], opened());
    expect(state.fileDraft).toEqual({
      text: '',
      message: 'Add bitbucket-pipelines.yml',
    });
    expect(state.busy).toBe(false);
  });

  it('opens what is on the branch with an "Update" message when there is one', () => {
    const state = run(
      [{ type: 'fileOpening' }, { type: 'fileOpened', text: 'pipelines: {}\n' }],
      opened({ configFile: 'present' })
    );
    expect(state.fileDraft?.text).toBe('pipelines: {}\n');
    expect(state.fileDraft?.message).toBe('Update bitbucket-pipelines.yml');
  });

  it('cannot be committed empty, and sends the box as it is with the message trimmed', () => {
    const open = run([{ type: 'fileOpened', text: null }], opened());
    expect(canCommit(open)).toBe(false);
    const filled = run(
      [
        { type: 'fileChanged', field: 'text', value: 'pipelines: {}\n' },
        { type: 'fileChanged', field: 'message', value: '  Add CI  ' },
      ],
      open
    );
    expect(canCommit(filled)).toBe(true);
    expect(fileRequest(filled.fileDraft!)).toEqual({ text: 'pipelines: {}\n', message: 'Add CI' });
  });

  it('a commit closes the editor and says where it went, reminding when Pipelines is off', () => {
    const done = run(
      [
        { type: 'fileOpened', text: null },
        { type: 'fileChanged', field: 'text', value: 'pipelines: {}\n' },
        { type: 'sent', what: 'file' },
        {
          type: 'fileCommitted',
          committed: { ref: 'main', url: 'https://bitbucket.org/acme/demo/src/main/x' },
        },
      ],
      opened({ enabled: false })
    );
    expect(done.fileDraft).toBeNull();
    expect(done.committed?.ref).toBe('main');
    expect(committedReminder(done)).toBe(' Turn Pipelines on above to run it.');
    expect(
      committedReminder(run([{ type: 'loaded', setup: setup({ enabled: true }) }], done))
    ).toBe('');
    // Opening the editor again takes the line away.
    expect(run([{ type: 'fileOpening' }], done).committed).toBeNull();
  });

  it('a file that cannot be read leaves the editor shut, with the reason', () => {
    const state = run(
      [{ type: 'fileOpening' }, { type: 'fileOpenFailed', error: 'Branch not found' }],
      opened()
    );
    expect(state).toMatchObject({ fileDraft: null, busy: false, error: 'Branch not found' });
  });

  it('cancelling throws the draft away', () => {
    const state = run([{ type: 'fileOpened', text: null }, { type: 'fileCancelled' }], opened());
    expect(state.fileDraft).toBeNull();
  });
});

describe('a text box', () => {
  it('grows with its lines, within bounds', () => {
    expect(textRows('', 4, 16)).toBe(4);
    expect(textRows('a\nb\nc\nd\ne', 4, 16)).toBe(6);
    expect(textRows('x\n'.repeat(40), 4, 16)).toBe(16);
  });
});
