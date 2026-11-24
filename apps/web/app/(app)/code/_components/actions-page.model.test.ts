import {
  actionsReducer,
  branchLabel,
  canCommitWorkflow,
  canConfigure,
  commitMessageFor,
  committedReminder,
  initialActions,
  workflowNameProblem,
  workflowRequest,
  workflowsLine,
  type ActionsAction,
  type ActionsPageSetup,
  type ActionsState,
} from './actions-page.model';

const setup = (over: Partial<ActionsPageSetup> = {}): ActionsPageSetup => ({
  enabled: true,
  enabledError: null,
  workflows: [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }],
  workflowsError: null,
  runs: [],
  runsError: null,
  variables: [{ uuid: 'REGION', key: 'REGION', value: 'eu', secured: false }],
  variablesError: null,
  secrets: [{ uuid: 'DEPLOY_TOKEN', key: 'DEPLOY_TOKEN', value: null, secured: true }],
  secretsError: null,
  environments: [],
  environmentsError: null,
  access: { configureNeeds: null },
  ...over,
});

const fold = (actions: ActionsAction[], from: ActionsState = initialActions): ActionsState =>
  actions.reduce(actionsReducer, from);

describe('a change that is refused', () => {
  it('keeps the open editor as it was and shows why', () => {
    const open = fold([{ type: 'fileOpened', name: 'ci.yml', text: 'name: CI' }]);
    const failed = fold(
      [
        { type: 'sent', what: 'file' },
        { type: 'failed', error: 'GitHub said no' },
      ],
      open
    );
    expect(failed.fileDraft?.text).toBe('name: CI');
    expect(failed.error).toBe('GitHub said no');
    expect(failed.busy).toBe(false);
  });

  it('a new change clears the last refusal while it is in flight', () => {
    const failed = fold([{ type: 'failed', error: 'GitHub said no' }]);
    const again = fold([{ type: 'sent', what: 'flip' }], failed);
    expect(again.error).toBeNull();
    expect(again.busy).toBe(true);
    expect(fold([{ type: 'flipped' }], again).busy).toBe(false);
  });
});

describe('writing a workflow file', () => {
  const opened = (name: string | null, text: string | null) =>
    fold([
      {
        type: 'fileOpened',
        name,
        text,
      },
    ]);

  it('opens an existing file by its name with its text', () => {
    const state = opened('ci.yml', 'on: pull_request');
    expect(state.fileDraft).toEqual({
      isNew: false,
      name: 'ci.yml',
      text: 'on: pull_request',
      message: 'Update ci.yml',
    });
  });

  it('a new file waits for a usable name before Commit is on', () => {
    let state = opened(null, null);
    state = fold([{ type: 'fileChanged', field: 'text', value: 'on: push' }], state);
    expect(canCommitWorkflow(state)).toBe(false);
    state = fold([{ type: 'fileChanged', field: 'name', value: 'build' }], state);
    expect(canCommitWorkflow(state)).toBe(false);
    state = fold([{ type: 'fileChanged', field: 'name', value: 'build.yml' }], state);
    expect(canCommitWorkflow(state)).toBe(true);
  });

  it('its commit message follows the name until the person writes their own', () => {
    let state = opened(null, null);
    state = fold([{ type: 'fileChanged', field: 'name', value: 'deploy.yml' }], state);
    expect(state.fileDraft?.message).toBe('Add deploy.yml');
    state = fold(
      [
        { type: 'fileChanged', field: 'message', value: 'Deploy on tag' },
        { type: 'fileChanged', field: 'name', value: 'release.yml' },
      ],
      state
    );
    expect(state.fileDraft?.message).toBe('Deploy on tag');
    expect(commitMessageFor('nope')).toBe('Add a workflow');
  });

  it('Commit sends the box as it is, the name and message trimmed', () => {
    let state = opened(null, null);
    state = fold(
      [
        { type: 'fileChanged', field: 'name', value: ' ci.yml ' },
        { type: 'fileChanged', field: 'message', value: '  Add CI  ' },
        { type: 'fileChanged', field: 'text', value: 'on: push\njobs: {}' },
      ],
      state
    );
    expect(workflowRequest(state.fileDraft!)).toEqual({
      name: 'ci.yml',
      text: 'on: push\njobs: {}',
      message: 'Add CI',
    });
  });

  it('Commit is off while a change is in flight and with an empty box', () => {
    let state = opened('ci.yml', '  ');
    expect(canCommitWorkflow(state)).toBe(false);
    state = fold([{ type: 'fileChanged', field: 'text', value: 'on: push' }], state);
    expect(canCommitWorkflow(state)).toBe(true);
    expect(canCommitWorkflow(fold([{ type: 'sent', what: 'file' }], state))).toBe(false);
  });

  it('names a taken or unusable file name, and nothing while the name is empty', () => {
    const files = setup().workflows!;
    const draft = (name: string) => ({ isNew: true, name, text: '', message: '' });
    expect(workflowNameProblem(draft(''), files)).toBeNull();
    expect(workflowNameProblem(draft('CI.yml'), files)).toMatch(/already a workflow/);
    expect(workflowNameProblem(draft('x'), files)).toMatch(/ending .yml or .yaml/);
    expect(workflowNameProblem(draft('new.yml'), files)).toBeNull();
    expect(workflowNameProblem({ ...draft('ci.yml'), isNew: false }, files)).toBeNull();
  });

  it('a commit closes the editor and says where it went', () => {
    const state = fold([
      { type: 'fileOpened', name: 'ci.yml', text: 'x' },
      { type: 'sent', what: 'file' },
      {
        type: 'fileCommitted',
        committed: { name: 'ci.yml', ref: 'main', url: 'https://github.com/a/b' },
      },
    ]);
    expect(state.fileDraft).toBeNull();
    expect(state.committed?.name).toBe('ci.yml');
    expect(
      committedReminder(fold([{ type: 'loaded', setup: setup({ enabled: false }) }], state))
    ).toMatch(/Turn Actions on/);
    expect(committedReminder(state)).toBe('');
  });
});

describe('what a person may change', () => {
  it('only an editor whose GitHub connection carries Configure Actions', () => {
    const open = fold([{ type: 'loaded', setup: setup() }]);
    const shut = fold([
      { type: 'loaded', setup: setup({ access: { configureNeeds: 'Reconnect GitHub.' } }) },
    ]);
    expect(canConfigure(open, true)).toBe(true);
    expect(canConfigure(open, false)).toBe(false);
    expect(canConfigure(shut, true)).toBe(false);
    expect(canConfigure(initialActions, true)).toBe(false);
  });
});

describe('the words on the page', () => {
  it('says how many workflows, or why none could be listed', () => {
    expect(workflowsLine(setup(), 'main')).toBe('1 on main.');
    expect(workflowsLine(setup({ workflows: [] }), 'main')).toBe('No workflow files on main yet.');
    expect(
      workflowsLine(setup({ workflows: null, workflowsError: 'GitHub is down' }), 'main')
    ).toBe('GitHub is down');
    expect(branchLabel('')).toBe('the default branch');
  });
});
