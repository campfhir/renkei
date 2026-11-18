import {
  actionsReducer,
  branchLabel,
  canCommitWorkflow,
  canConfigure,
  commitMessageFor,
  committedReminder,
  initialActions,
  secretsNote,
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

describe('editing a variable set', () => {
  it('opens a set as its plain variables, as text', () => {
    const state = fold([
      { type: 'loaded', setup: setup() },
      { type: 'variablesOpened', scope: {}, variables: setup().variables },
    ]);
    expect(state.draft).toEqual({ text: 'REGION=eu' });
  });

  it('keeps an environment’s name as its scope, and clears the box after a save', () => {
    const state = fold([
      { type: 'variablesOpened', scope: { environmentUuid: 'production' }, variables: [] },
      { type: 'variablesChanged', text: 'A=1' },
    ]);
    expect(state.draft).toEqual({ environmentUuid: 'production', text: 'A=1' });
    const saved = fold(
      [
        { type: 'sent', what: 'variables' },
        {
          type: 'variablesSaved',
          outcome: {
            environmentUuid: 'production',
            added: ['A'],
            changed: [],
            removed: [],
            errors: [],
            problems: [],
          },
        },
      ],
      state
    );
    expect(saved.draft).toBeNull();
    expect(saved.busy).toBe(false);
    expect(saved.outcome?.added).toEqual(['A']);
  });

  it('a refused change keeps every editor as it was and shows why', () => {
    const open = fold([{ type: 'variablesOpened', scope: {}, variables: [] }]);
    const failed = fold(
      [
        { type: 'sent', what: 'variables' },
        { type: 'failed', error: 'GitHub said no' },
      ],
      open
    );
    expect(failed.draft).toEqual({ text: '' });
    expect(failed.error).toBe('GitHub said no');
    expect(failed.busy).toBe(false);
  });
});

describe('writing a workflow file', () => {
  const opened = (name: string | null, text: string | null) =>
    fold([
      {
        type: 'fileOpened',
        name,
        text,
        templates: [
          { id: 't1', provider: 'github', name: 'Node', description: null, body: 'on: push' },
        ],
      },
    ]);

  it('opens an existing file by its name with its text', () => {
    const state = opened('ci.yml', 'on: pull_request');
    expect(state.fileDraft).toEqual({
      isNew: false,
      name: 'ci.yml',
      text: 'on: pull_request',
      message: 'Update ci.yml',
      templateId: '',
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

  it('a picked template fills the box, and Commit sends the box as it is', () => {
    let state = opened(null, null);
    state = fold(
      [
        { type: 'templatePicked', templateId: 't1' },
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
    const draft = (name: string) => ({ isNew: true, name, text: '', message: '', templateId: '' });
    expect(workflowNameProblem(draft(''), files)).toBeNull();
    expect(workflowNameProblem(draft('CI.yml'), files)).toMatch(/already a workflow/);
    expect(workflowNameProblem(draft('x'), files)).toMatch(/ending .yml or .yaml/);
    expect(workflowNameProblem(draft('new.yml'), files)).toBeNull();
    expect(workflowNameProblem({ ...draft('ci.yml'), isNew: false }, files)).toBeNull();
  });

  it('a commit closes the editor and says where it went', () => {
    const state = fold([
      { type: 'fileOpened', name: 'ci.yml', text: 'x', templates: [] },
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

  it('says secrets are set on GitHub', () => {
    expect(secretsNote(0)).toMatch(/added on GitHub/);
    expect(secretsNote(2)).toMatch(/listed by name/);
  });
});
