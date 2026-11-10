/**
 * The Pipelines page's behaviour (pipelines-page.model.ts), as a person
 * using it would describe it. The browser spec (code-pipelines.spec.ts)
 * keeps the card and page rendering what the Bitbucket stand-in answers,
 * one press through each kind of change, and the phone width.
 */

import type { PipelineRun, PipelineVariable } from '@/lib/code/bitbucket-pipelines';
import type { PipelineTemplate } from '@/lib/code/pipeline-templates';
import {
  branchLabel,
  canCommit,
  canRun,
  canSetVariables,
  canStartRun,
  committedReminder,
  draftFor,
  duration,
  environmentHint,
  fileRequest,
  initialPipelines,
  keysInText,
  outcomeFor,
  outcomeLines,
  outcomeOf,
  pipelinesReducer,
  pipelinesUrl,
  removalQuestion,
  runRequest,
  runStatePill,
  templateBlankOption,
  templateOptionLabel,
  textRows,
  variableShown,
  variablesButtonLabel,
  variablesGoing,
  variablesRequest,
  type Outcome,
  type PipelinesAction,
  type PipelinesState,
  type Setup,
} from './pipelines-page.model';

const variable = (key: string, value: string | null = 'v', secured = false): PipelineVariable => ({
  uuid: `{${key}}`,
  key,
  value: secured ? null : value,
  secured,
});

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

const TEMPLATES: PipelineTemplate[] = [
  {
    id: 't-pnpm',
    provider: 'atlassian-bitbucket',
    name: 'Node with pnpm',
    description: 'Install with pnpm, then test.',
    body: 'pipelines:\n  default:\n    - step:\n        script:\n          - pnpm install --frozen-lockfile\n',
  },
  {
    id: 't-bare',
    provider: 'atlassian-bitbucket',
    name: 'Bare skeleton',
    description: null,
    body: 'pipelines: {}\n',
  },
];

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
    const state = run(
      [{ type: 'fileOpening' }, { type: 'fileOpened', text: null, templates: TEMPLATES }],
      opened()
    );
    expect(state.fileDraft).toEqual({
      text: '',
      message: 'Add bitbucket-pipelines.yml',
      templateId: '',
    });
    expect(state.busy).toBe(false);
    expect(templateBlankOption(state.fileDraft!)).toBe('Pick a template…');
  });

  it('opens what is on the branch with an "Update" message when there is one', () => {
    const state = run(
      [{ type: 'fileOpening' }, { type: 'fileOpened', text: 'pipelines: {}\n', templates: [] }],
      opened({ configFile: 'present' })
    );
    expect(state.fileDraft?.text).toBe('pipelines: {}\n');
    expect(state.fileDraft?.message).toBe('Update bitbucket-pipelines.yml');
    expect(templateBlankOption(state.fileDraft!)).toBe('Keep what is here');
  });

  it('a picked template fills the box; the empty choice keeps what is there', () => {
    const open = run([{ type: 'fileOpened', text: null, templates: TEMPLATES }], opened());
    const picked = run([{ type: 'templatePicked', templateId: 't-pnpm' }], open);
    expect(picked.fileDraft?.text).toMatch(/pnpm install --frozen-lockfile/);
    const edited = run(
      [
        { type: 'fileChanged', field: 'text', value: 'mine' },
        { type: 'templatePicked', templateId: '' },
      ],
      picked
    );
    expect(edited.fileDraft).toMatchObject({ text: 'mine', templateId: '' });
  });

  it('lists a template with its description when it has one', () => {
    expect(templateOptionLabel(TEMPLATES[0]!)).toBe(
      'Node with pnpm — Install with pnpm, then test.'
    );
    expect(templateOptionLabel(TEMPLATES[1]!)).toBe('Bare skeleton');
  });

  it('cannot be committed empty, and sends the box as it is with the message trimmed', () => {
    const open = run([{ type: 'fileOpened', text: null, templates: TEMPLATES }], opened());
    expect(canCommit(open)).toBe(false);
    const filled = run(
      [
        { type: 'templatePicked', templateId: 't-bare' },
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
        { type: 'fileOpened', text: null, templates: TEMPLATES },
        { type: 'templatePicked', templateId: 't-bare' },
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
    const state = run(
      [{ type: 'fileOpened', text: null, templates: [] }, { type: 'fileCancelled' }],
      opened()
    );
    expect(state.fileDraft).toBeNull();
  });
});

describe('variables as text', () => {
  it('an editor sets them only when the grant may', () => {
    expect(canSetVariables(opened(), true)).toBe(true);
    expect(canSetVariables(opened(), false)).toBe(false);
    expect(
      canSetVariables(
        opened({
          access: { configureNeeds: null, variablesNeeds: 'Reconnect with pipeline:variable' },
        }),
        true
      )
    ).toBe(false);
  });

  it('opens a set as its text, a secured one without its value', () => {
    const state = run(
      [
        {
          type: 'variablesOpened',
          scope: {},
          variables: [
            variable('API_BASE_URL', 'https://api.example.test'),
            variable('NPM_TOKEN', null, true),
          ],
        },
      ],
      opened()
    );
    expect(state.draft).toEqual({
      text: 'API_BASE_URL=https://api.example.test\nsecret NPM_TOKEN=',
    });
  });

  it('says Add with nothing yet, Edit once there is something', () => {
    expect(variablesButtonLabel([])).toBe('Add variables');
    expect(variablesButtonLabel([variable('A')])).toBe('Edit variables');
  });

  it('shows a secured value as Secured, never the value, and an empty one as (empty)', () => {
    expect(variableShown(variable('NPM_TOKEN', 'npm_secret', true))).toEqual({ secured: true });
    expect(variableShown(variable('A', 'x'))).toEqual({ value: 'x' });
    expect(variableShown(variable('A', ''))).toEqual({ value: '(empty)' });
  });

  it('reads the keys a line names, with secret and export in front, ignoring a broken line', () => {
    expect([
      ...keysInText('secret NPM_TOKEN=x\nAPI_BASE_URL: y\nexport PATHY=1\nthis line is broken\n'),
    ]).toEqual(['NPM_TOKEN', 'API_BASE_URL', 'PATHY']);
  });

  it('asks before a line taken out removes its variable, naming it', () => {
    const current = [variable('API_BASE_URL'), variable('NPM_TOKEN', null, true)];
    const going = variablesGoing('secret NPM_TOKEN=\n', current);
    expect(going.map((v) => v.key)).toEqual(['API_BASE_URL']);
    expect(removalQuestion(going)).toBe(
      'Remove API_BASE_URL? Pipeline runs will no longer see it.'
    );
    expect(removalQuestion(variablesGoing('', current))).toBe(
      'Remove API_BASE_URL, NPM_TOKEN? Pipeline runs will no longer see them.'
    );
    expect(
      removalQuestion(variablesGoing('API_BASE_URL=2\nsecret NPM_TOKEN=', current))
    ).toBeNull();
  });

  it('sends the text, and the environment only for an environment’s set', () => {
    expect(variablesRequest({ text: 'A=1' })).toEqual({ text: 'A=1' });
    expect(variablesRequest({ text: 'A=1', environmentUuid: '{prod}' })).toEqual({
      text: 'A=1',
      environmentUuid: '{prod}',
    });
  });

  it('one box is open at a time, and it belongs to the set it was opened on', () => {
    const repo = run([{ type: 'variablesOpened', scope: {}, variables: [] }], opened());
    expect(draftFor(repo, {})).not.toBeNull();
    expect(draftFor(repo, { environmentUuid: '{prod}' })).toBeNull();
    const prod = run(
      [{ type: 'variablesOpened', scope: { environmentUuid: '{prod}' }, variables: [] }],
      repo
    );
    expect(draftFor(prod, {})).toBeNull();
    expect(draftFor(prod, { environmentUuid: '{prod}' })?.text).toBe('');
  });

  it('a save closes the box and shows what it did under that set only', () => {
    const draft = { text: 'secret DEPLOY_KEY=x', environmentUuid: '{prod}' };
    const answer = { added: ['DEPLOY_KEY'], changed: [], removed: [], errors: [], problems: [] };
    const saved = run(
      [
        { type: 'variablesOpened', scope: { environmentUuid: '{prod}' }, variables: [] },
        { type: 'variablesChanged', text: draft.text },
        { type: 'sent', what: 'variables' },
        { type: 'variablesSaved', outcome: outcomeOf(draft, answer) },
      ],
      opened()
    );
    expect(saved.draft).toBeNull();
    expect(outcomeFor(saved, { environmentUuid: '{prod}' })?.added).toEqual(['DEPLOY_KEY']);
    expect(outcomeFor(saved, {})).toBeNull();
    // The next save takes the last outcome away while it goes.
    expect(run([{ type: 'sent', what: 'variables' }], saved).outcome).toBeNull();
  });

  it('a refused save keeps the box and its text', () => {
    const refused = run(
      [
        { type: 'variablesOpened', scope: {}, variables: [] },
        { type: 'variablesChanged', text: 'A=1' },
        { type: 'sent', what: 'variables' },
        { type: 'failed', error: 'Bitbucket refused' },
      ],
      opened()
    );
    expect(refused.draft?.text).toBe('A=1');
    expect(refused.error).toBe('Bitbucket refused');
  });

  it('words what a save did: added, changed, removed, refused and lines not read', () => {
    const outcome = (more: Partial<Outcome>): Outcome => ({
      added: [],
      changed: [],
      removed: [],
      errors: [],
      problems: [],
      ...more,
    });
    expect(
      outcomeLines(outcome({ added: ['NPM_TOKEN', 'API_BASE_URL'], problems: ['line 3'] }))
    ).toEqual({
      status: 'added NPM_TOKEN, API_BASE_URL.',
      notApplied: null,
      notRead: 'Not read as variables: line 3.',
    });
    expect(outcomeLines(outcome({ changed: ['A'], removed: ['B'] })).status).toBe(
      'changed A · removed B.'
    );
    expect(outcomeLines(outcome({})).status).toBe('Nothing changed.');
    expect(outcomeLines(outcome({ errors: ['A: too long'] }))).toEqual({
      status: null,
      notApplied: 'Not applied: A: too long',
      notRead: null,
    });
  });

  it('says which runs an environment’s set reaches', () => {
    expect(environmentHint({ type: 'Production' })).toBe(
      'Runs deploying to this production environment get these as well.'
    );
    expect(environmentHint({ type: '' })).toBe(
      'Runs deploying to this environment get these as well.'
    );
  });

  it('grows a box with its lines, within bounds', () => {
    expect(textRows('', 4, 16)).toBe(4);
    expect(textRows('a\nb\nc\nd\ne', 4, 16)).toBe(6);
    expect(textRows('x\n'.repeat(40), 4, 16)).toBe(16);
  });
});
