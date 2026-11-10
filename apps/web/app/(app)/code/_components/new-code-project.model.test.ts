/**
 * The new-code-project form (new-code-project.model.ts), as a person
 * using it would describe it: the host, the repository chosen or created,
 * the template filling Instructions, and what Create sends. The `.env`'s
 * parsing is the server's (packages/connector-sandbox/src/dotenv.test.ts).
 * code.spec.ts keeps one project made through the form with a freshly
 * created repository; project-templates.spec.ts keeps the catalog showing
 * in the picker.
 */

import {
  branchPlaceholder,
  canCreate,
  createdUrl,
  createRepository,
  createRequest,
  initialNewProject,
  isConnected,
  newProjectReducer,
  repoListUrl,
  showsHostSwitch,
  showsTemplates,
  type NewProjectAction,
  type NewProjectState,
} from './new-code-project.model';

const BRIEF = 'Read before you write, test-first, small complete changes.';
const both = { bitbucketConnected: true, githubConnected: true };
const bitbucketOnly = { bitbucketConnected: true, githubConnected: false };
const githubOnly = { bitbucketConnected: false, githubConnected: true };

const start = (hosts = bitbucketOnly) => initialNewProject({ ...hosts, instructions: BRIEF });
const run = (actions: NewProjectAction[], from: NewProjectState = start()) =>
  actions.reduce(newProjectReducer, from);

const billing = {
  fullName: 'acme/billing-service',
  name: 'billing-service',
  projectKey: 'BILL',
  mainBranch: 'develop',
  updatedOn: null,
};

const templates = [
  { id: 't1', name: 'Generic developer brief', description: null, instructions: BRIEF },
  {
    id: 't2',
    name: 'Full-stack application',
    description: null,
    instructions: 'You are a professional full-stack developer.',
  },
];

describe('the git host', () => {
  it('starts on whichever host is connected; both connected starts on Bitbucket', () => {
    expect(start(githubOnly).provider).toBe('github');
    expect(start(bitbucketOnly).provider).toBe('atlassian-bitbucket');
    expect(start(both).provider).toBe('atlassian-bitbucket');
    expect(start({ bitbucketConnected: false, githubConnected: false }).provider).toBe(
      'atlassian-bitbucket'
    );
  });

  it('offers the switch only when both are connected', () => {
    expect(showsHostSwitch(both)).toBe(true);
    expect(showsHostSwitch(bitbucketOnly)).toBe(false);
  });

  it('switching host drops the repository and branch chosen on the other', () => {
    const chosen = run(
      [
        { type: 'chosen', repo: billing },
        { type: 'branch', value: 'main' },
        { type: 'provider', provider: 'github' },
      ],
      start(both)
    );
    expect(chosen).toMatchObject({ provider: 'github', chosen: null, branch: '' });
    // The name the repository gave stays the person's.
    expect(chosen.name).toBe('billing-service');
  });

  it('pressing the host already chosen changes nothing', () => {
    const chosen = run([{ type: 'chosen', repo: billing }], start(both));
    expect(run([{ type: 'provider', provider: 'atlassian-bitbucket' }], chosen)).toBe(chosen);
  });

  it('a host that is not connected cannot create', () => {
    const state = run([{ type: 'chosen', repo: billing }], start(githubOnly));
    expect(isConnected(state, githubOnly)).toBe(true);
    const onBitbucket = run([{ type: 'provider', provider: 'atlassian-bitbucket' }], state);
    expect(isConnected(onBitbucket, githubOnly)).toBe(false);
  });
});

describe('the repository', () => {
  it('Create project is off until a repository is chosen', () => {
    expect(canCreate(start(), bitbucketOnly)).toBe(false);
    expect(canCreate(run([{ type: 'chosen', repo: billing }]), bitbucketOnly)).toBe(true);
  });

  it('a chosen repository names the project, unless a name was already typed', () => {
    expect(run([{ type: 'chosen', repo: billing }]).name).toBe('billing-service');
    expect(
      run([
        { type: 'name', value: 'Billing' },
        { type: 'chosen', repo: billing },
      ]).name
    ).toBe('Billing');
  });

  it('the branch field suggests the repository’s main branch', () => {
    expect(branchPlaceholder(run([{ type: 'chosen', repo: billing }]))).toBe('develop');
    expect(
      branchPlaceholder(run([{ type: 'chosen', repo: { ...billing, mainBranch: null } }]))
    ).toBe('main branch');
  });

  it('Choose another clears the repository and the branch', () => {
    const state = run([
      { type: 'chosen', repo: billing },
      { type: 'branch', value: 'release' },
      { type: 'chooseAnother' },
    ]);
    expect(state).toMatchObject({ chosen: null, branch: '' });
  });
});

describe('the template picker', () => {
  it('starts on the developer’s brief, nothing picked, and shows once the catalog has rows', () => {
    const state = start();
    expect(state.instructions).toBe(BRIEF);
    expect(state.templateId).toBe('');
    expect(showsTemplates(state)).toBe(false);
    expect(showsTemplates(run([{ type: 'templatesLoaded', templates: [] }]))).toBe(false);
    expect(showsTemplates(run([{ type: 'templatesLoaded', templates }]))).toBe(true);
  });

  it('picking a template fills Instructions, which stay editable afterwards', () => {
    const picked = run([
      { type: 'templatesLoaded', templates },
      { type: 'template', templateId: 't2' },
    ]);
    expect(picked.instructions).toBe('You are a professional full-stack developer.');
    const edited = run(
      [{ type: 'instructions', value: 'You are a professional full-stack developer. Use pnpm.' }],
      picked
    );
    expect(edited.instructions).toMatch(/Use pnpm/);
    // The picker does not snap back to match the text.
    expect(edited.templateId).toBe('t2');
  });

  it('going back to "Pick a template…" leaves the text as it is', () => {
    const state = run([
      { type: 'templatesLoaded', templates },
      { type: 'template', templateId: 't2' },
      { type: 'template', templateId: '' },
    ]);
    expect(state.instructions).toBe('You are a professional full-stack developer.');
  });
});

describe('what Create project sends', () => {
  it('nothing until a repository is chosen', () => {
    expect(createRequest(start())).toBeNull();
  });

  it('the repository, the trimmed fields, and the .env exactly as pasted', () => {
    const env = '# comment\nNPM_TOKEN=abc \nexport API=1\n';
    const state = run([
      { type: 'chosen', repo: billing },
      { type: 'name', value: '  Billing  ' },
      { type: 'branch', value: ' release ' },
      { type: 'env', value: env },
      { type: 'instructions', value: '  Be careful.  ' },
    ]);
    expect(createRequest(state)).toEqual({
      name: 'Billing',
      provider: 'atlassian-bitbucket',
      repository: 'acme/billing-service',
      branch: 'release',
      env,
      instructions: 'Be careful.',
    });
  });

  it('a name cleared back to nothing falls back to the repository’s', () => {
    const state = run([
      { type: 'chosen', repo: billing },
      { type: 'name', value: '   ' },
    ]);
    expect(createRequest(state)?.name).toBe('billing-service');
  });

  it('tools are sent only when chosen for this project; otherwise it inherits', () => {
    const chosen = run([{ type: 'chosen', repo: billing }]);
    expect(createRequest(chosen)).not.toHaveProperty('toolConfig');
    const own = run([{ type: 'connectors', connectors: ['jira', 'sandbox'] }], chosen);
    expect(createRequest(own)?.toolConfig).toEqual({ connectors: ['jira', 'sandbox'] });
  });

  it('is off while sending; a refusal says why and lets it go again', () => {
    const chosen = run([{ type: 'chosen', repo: billing }]);
    const sending = run([{ type: 'sent' }], chosen);
    expect(canCreate(sending, bitbucketOnly)).toBe(false);
    const failed = run([{ type: 'failed', error: 'Not allowed' }], sending);
    expect(failed.error).toBe('Not allowed');
    expect(canCreate(failed, bitbucketOnly)).toBe(true);
  });

  it('opens the new project, carrying any .env lines the server could not read', () => {
    expect(createdUrl('p1', [])).toBe('/code/p1');
    expect(createdUrl('p1', ['line 2: no "="', 'line 5: empty name'])).toBe(
      '/code/p1?envProblems=line%202%3A%20no%20%22%3D%22%0Aline%205%3A%20empty%20name'
    );
  });
});

describe('browsing repositories', () => {
  it('lists nothing until an owner is picked or something is typed', () => {
    expect(
      repoListUrl({ provider: 'atlassian-bitbucket', owner: '', project: '', query: '  ' })
    ).toBeNull();
  });

  it('a Bitbucket browse narrows by workspace, project and name', () => {
    expect(
      repoListUrl({
        provider: 'atlassian-bitbucket',
        owner: 'acme',
        project: 'BILL',
        query: ' bill ',
      })
    ).toBe('/api/code/repos?workspace=acme&project=BILL&q=bill');
    expect(
      repoListUrl({ provider: 'atlassian-bitbucket', owner: '', project: '', query: 'bill' })
    ).toBe('/api/code/repos?q=bill');
  });

  it('a GitHub browse has accounts and no projects', () => {
    expect(repoListUrl({ provider: 'github', owner: 'acme', project: 'X', query: '' })).toBe(
      '/api/code/github/repos?account=acme'
    );
  });
});

describe('Create repository', () => {
  it('on Bitbucket needs the workspace, the project and a name', () => {
    const base = { provider: 'atlassian-bitbucket' as const, owner: 'acme', project: '', name: '' };
    expect(createRepository(base).canCreate).toBe(false);
    expect(createRepository({ ...base, project: 'NOTIF' }).canCreate).toBe(false);
    const ready = createRepository({ ...base, project: 'NOTIF', name: ' Notify Service ' });
    expect(ready.canCreate).toBe(true);
    expect(ready.slug).toBe('notify-service');
    expect(ready.request).toEqual({
      url: '/api/code/bitbucket/repos',
      body: { workspace: 'acme', project: 'NOTIF', name: 'Notify Service' },
    });
  });

  it('on GitHub needs the account and a name', () => {
    const ready = createRepository({ provider: 'github', owner: 'acme', project: '', name: 'api' });
    expect(ready.canCreate).toBe(true);
    expect(ready.request).toEqual({
      url: '/api/code/github/repos',
      body: { account: 'acme', name: 'api' },
    });
  });

  it('says what it will create once there is an owner and a name', () => {
    expect(
      createRepository({
        provider: 'atlassian-bitbucket',
        owner: 'acme',
        project: 'N',
        name: 'My Repo',
      }).hint
    ).toBe('Creates acme/my-repo — empty and private.');
    expect(
      createRepository({ provider: 'github', owner: '', project: '', name: 'x' }).hint
    ).toMatch(/^An empty, private repository/);
  });

  it('a name with nothing usable in it cannot be created', () => {
    const plan = createRepository({ provider: 'github', owner: 'acme', project: '', name: '---' });
    expect(plan.canCreate).toBe(false);
    expect(plan.hint).toBe('Creates acme/… — empty and private.');
  });
});
