import type { BlockDefinition } from '@renkei/ci-blocks';
import {
  blockChoices,
  builderReducer,
  canOpenPullRequest,
  canSave,
  checks,
  environmentFormProblems,
  fileStatus,
  fileText,
  initialBuilder,
  isDirty,
  ownBlocks,
  partCards,
  pullRequestNote,
  variableLinks,
  pullRequestNotice,
  saveRequest,
  stepEditor,
  type BuilderAction,
  type BuilderData,
  type BuilderState,
} from './pipeline-builder.model';

const goBuild: BlockDefinition = {
  kind: 'build',
  runsOn: { type: 'hosted', image: 'golang:1.23' },
  inputs: [{ name: 'packages', type: 'text', default: './...' }],
  variables: [],
  consumes: [],
  produces: [{ name: 'dist', paths: ['dist'] }],
  caches: [],
  commands: 'go build -o dist/ ${input.packages}',
};
const systemd: BlockDefinition = {
  kind: 'deploy',
  runsOn: { type: 'target' },
  inputs: [
    { name: 'service_name', type: 'text', description: 'The systemd unit' },
    { name: 'health_url', type: 'url' },
  ],
  variables: [{ name: 'HEALTH_TOKEN', secured: true }],
  consumes: ['dist'],
  produces: [],
  caches: [],
  commands: 'sudo systemctl restart ${input.service_name}',
};
const lint: BlockDefinition = { ...goBuild, kind: 'check', produces: [], inputs: [] };

const build = { block: 'go-test-build', version: 3, inputs: {} };
const deploy = {
  block: 'deploy-systemd',
  version: 1,
  inputs: { service_name: 'sync-worker', health_url: 'http://localhost/health' },
  target: 'onprem-workers',
};

const data: BuilderData = {
  host: 'github',
  file: '.github/workflows/pipeline.yml',
  spec: {
    checks: [build],
    environments: [
      { name: 'dev', branch: 'develop', steps: [build, deploy] },
      { name: 'production', branch: 'main', steps: [build, deploy] },
    ],
  },
  suggested: true,
  found: ['Go · go.mod'],
  blocks: [
    {
      key: 'go-test-build',
      name: 'Go: vet, test, build',
      version: 3,
      definition: goBuild,
      description: null,
    },
    {
      key: 'go-test-build',
      name: 'Go: vet, test, build',
      version: 2,
      definition: goBuild,
      description: null,
    },
    {
      key: 'deploy-systemd',
      name: 'Deploy with systemd',
      version: 1,
      definition: systemd,
      description: 'Restart a unit',
    },
    { key: 'go-lint', name: 'Go: lint', version: 1, definition: lint, description: null },
  ],
  targets: [
    {
      name: 'onprem-workers',
      labels: { bitbucket: [], github: ['self-hosted', 'onprem-workers'] },
      runners: [
        { host: 'github', id: '1', name: 'w-01', labels: [], status: 'online', busy: false },
      ],
    },
    { name: 'bb-only', labels: { bitbucket: ['self.hosted', 'x'], github: [] }, runners: [] },
  ],
  facts: {
    host: 'github',
    branch: 'main',
    repoVariables: ['HEALTH_TOKEN'],
    environments: [
      { name: 'dev', variables: [] },
      { name: 'production', variables: [] },
    ],
    branches: ['main', 'develop'],
    existingFile: null,
    lastWritten: null,
  },
  unread: [],
  pullRequestUrl: null,
  report: {
    url: 'https://renkei.example/api/deployments/report',
    audience: 'https://renkei.example',
  },
  canEdit: true,
  project: { name: 'sync-worker', repo: 'acme/sync-worker', branch: 'main' },
};

const run = (actions: BuilderAction[], start: BuilderState = initialBuilder) =>
  actions.reduce(builderReducer, start);
const loaded = run([{ type: 'loaded', data }]);

describe('the suggested pipeline', () => {
  it('shows each row: pull requests, then each environment’s branch, with its steps', () => {
    expect(partCards(loaded).map((p) => [p.title, p.detail, p.steps.map((s) => s.name)])).toEqual([
      ['On every pull request', 'Checks only; nothing deploys.', ['Go: vet, test, build']],
      [
        'On merge to develop',
        'Deploys environment dev.',
        ['Go: vet, test, build', 'Deploy with systemd'],
      ],
      [
        'On merge to main',
        'Deploys environment production.',
        ['Go: vet, test, build', 'Deploy with systemd'],
      ],
    ]);
    expect(partCards(loaded)[1].steps[1]).toMatchObject({
      summary: 'service_name: sync-worker · health_url: http://localhost/health',
      target: 'onprem-workers',
      newer: null,
    });
    expect(fileStatus(loaded)).toBe('No .github/workflows/pipeline.yml on main yet');
  });

  it('is not saved yet, so Save is on; the file can be written, so a pull request can open', () => {
    expect(canSave(loaded)).toBe(true);
    expect(canOpenPullRequest(loaded)).toBe(true);
    expect(fileText(loaded)).toMatchObject({ ok: true });
    // Each deploy reports to Renkei, with a token GitHub signs.
    const text = fileText(loaded);
    expect(text?.ok && text.value).toContain('id-token: write');
    expect(text?.ok && text.value).toContain('https://renkei.example/api/deployments/report');
    expect(pullRequestNote(loaded)).toBe(
      'Merging it starts the pipeline on the branches it names.'
    );
    expect(saveRequest(loaded)).toEqual({ spec: data.spec });
  });

  it('opens saved, with nothing to save, when it was saved before', () => {
    const saved = run([{ type: 'loaded', data: { ...data, suggested: false } }]);
    expect(canSave(saved)).toBe(false);
  });

  it('lets a viewer look, and change nothing', () => {
    const viewer = run([{ type: 'loaded', data: { ...data, canEdit: false } }]);
    expect(canSave(viewer)).toBe(false);
    expect(canOpenPullRequest(viewer)).toBe(false);
    expect(pullRequestNote(viewer)).toBe('Only the project’s editors change its pipeline.');
  });
});

describe('editing the rows', () => {
  it('adds a block from the picker — no deploys on pull requests — and opens what needs filling in', () => {
    expect(blockChoices(loaded, null).map((c) => c.key)).toEqual(['go-lint', 'go-test-build']);
    expect(blockChoices(loaded, 'dev').map((c) => c.key)).toEqual([
      'deploy-systemd',
      'go-lint',
      'go-test-build',
    ]);
    const added = run(
      [
        { type: 'openPicker', part: 'dev' },
        { type: 'addStep', part: 'dev', block: 'deploy-systemd' },
      ],
      loaded
    );
    expect(added.picking).toBeNull();
    // At its latest version, on the target with runners online, its inputs open.
    expect(added.spec?.environments[0].steps[2]).toEqual({
      block: 'deploy-systemd',
      version: 1,
      inputs: {},
      target: 'onprem-workers',
    });
    expect(added.selected).toEqual({ part: 'dev', index: 2 });
    // A block whose inputs all have defaults is added closed.
    expect(run([{ type: 'addStep', part: null, block: 'go-lint' }], loaded).selected).toBeNull();
  });

  it('fills in a step’s inputs and target, and says what each input is', () => {
    const state = run(
      [
        { type: 'select', step: { part: 'production', index: 1 } },
        {
          type: 'setInput',
          step: { part: 'production', index: 1 },
          name: 'service_name',
          value: 'sync',
        },
        { type: 'setTarget', step: { part: 'production', index: 1 }, target: 'bb-only' },
      ],
      loaded
    );
    const editor = stepEditor(state);
    expect(editor).toMatchObject({
      name: 'Deploy with systemd',
      where: 'production, step 2',
      target: 'bb-only',
      canMoveBack: true,
      canMoveOn: false,
    });
    expect(editor?.fields[0]).toEqual({
      name: 'service_name',
      type: 'text',
      value: 'sync',
      placeholder: '',
      hint: 'The systemd unit',
      required: true,
    });
    expect(editor?.targets).toEqual([
      { name: 'onprem-workers', label: 'onprem-workers' },
      { name: 'bb-only', label: 'bb-only (no GitHub labels)' },
    ]);
    // A target without this host's labels fails its check.
    expect(checks(state).map((c) => c.text)).toContain(
      'Target bb-only has no GitHub runner labels, so GitHub cannot run its steps.'
    );
  });

  it('moves and removes steps; a deploy moved before its build is called out', () => {
    const moved = run([{ type: 'moveStep', step: { part: 'dev', index: 1 }, by: -1 }], loaded);
    expect(moved.spec?.environments[0].steps.map((s) => s.block)).toEqual([
      'deploy-systemd',
      'go-test-build',
    ]);
    expect(moved.selected).toEqual({ part: 'dev', index: 0 });
    expect(checks(moved)[0]).toMatchObject({
      state: 'fail',
      text: 'dev: “Deploy with systemd” needs the dist artifact, and no step before it in dev leaves one.',
    });
    const removed = run([{ type: 'removeStep', step: { part: null, index: 0 } }], loaded);
    expect(removed.spec?.checks).toEqual([]);
    expect(checks(removed).map((c) => c.text)).toContain(
      'Pull requests run nothing: add a block that tests or builds.'
    );
  });

  it('a step left unfilled stops the pull request, and says where', () => {
    const state = run(
      [{ type: 'setInput', step: { part: 'dev', index: 1 }, name: 'health_url', value: '' }],
      {
        ...loaded,
        spec: {
          ...data.spec,
          environments: [
            { ...data.spec.environments[0], steps: [build, { ...deploy, inputs: {} }] },
          ],
        },
      }
    );
    expect(canOpenPullRequest(state)).toBe(false);
    expect(pullRequestNote(state)).toBe('Fill in what the checks mark as needing fixing first.');
    expect(fileText(state)).toEqual({
      ok: false,
      errors: ['dev, step 2: Fill in “service_name”.', 'dev, step 2: Fill in “health_url”.'],
    });
    expect(partCards(state)[1].steps[1].summary).toBe(
      'service_name: (fill in) · health_url: (fill in)'
    );
  });

  it('offers a newer block version, and takes it', () => {
    const old = run([
      {
        type: 'loaded',
        data: { ...data, spec: { ...data.spec, checks: [{ ...build, version: 2 }] } },
      },
    ]);
    expect(partCards(old)[0].steps[0].newer).toBe(3);
    const updated = run([{ type: 'updateStep', step: { part: null, index: 0 } }], old);
    expect(updated.spec?.checks[0].version).toBe(3);
  });
});

describe('environments', () => {
  it('adds one from the form — staging once dev exists — building and deploying as the last one does', () => {
    const open = run([{ type: 'openEnvironmentForm' }], loaded);
    expect(open.environmentForm).toEqual({ name: 'staging', branch: 'staging' });
    const added = run([{ type: 'addEnvironment' }], open);
    expect(added.spec?.environments.map((e) => [e.name, e.branch, e.steps.length])).toEqual([
      ['dev', 'develop', 2],
      ['production', 'main', 2],
      ['staging', 'staging', 2],
    ]);
    expect(added.environmentForm).toBeNull();
  });

  it('names a taken name or branch, and adds nothing', () => {
    const open = run(
      [
        { type: 'openEnvironmentForm' },
        { type: 'environmentField', patch: { name: 'Dev', branch: 'main' } },
      ],
      loaded
    );
    expect(environmentFormProblems(open)).toEqual([
      'There is an environment named Dev already.',
      'main deploys another environment already.',
    ]);
    expect(run([{ type: 'addEnvironment' }], open).spec).toEqual(data.spec);
  });

  it('retargets a branch, and removes an environment', () => {
    const state = run(
      [
        { type: 'setBranch', environment: 'dev', branch: 'next' },
        { type: 'removeEnvironment', environment: 'production' },
      ],
      loaded
    );
    expect(state.spec?.environments.map((e) => [e.name, e.branch])).toEqual([['dev', 'next']]);
    expect(checks(state).map((c) => c.text)).toContain(
      'next does not exist yet: the pull request makes it from main, and dev deploys once this pipeline reaches it.'
    );
  });
});

describe('saving and the pull request', () => {
  it('a reload that lands after an edit keeps the edit', () => {
    const edited = run([{ type: 'removeStep', step: { part: null, index: 0 } }], loaded);
    const reloaded = run([{ type: 'loaded', data }], edited);
    expect(reloaded.spec?.checks).toEqual([]);
    expect(canSave(reloaded)).toBe(true);
  });

  it('a save keeps the pipeline, and a reload after it keeps what is on screen', () => {
    const edited = run([{ type: 'removeStep', step: { part: null, index: 0 } }], loaded);
    const saved = run([{ type: 'sent', busy: 'save' }, { type: 'saved' }], edited);
    expect(saved.notice).toBe('Pipeline saved.');
    expect(canSave(saved)).toBe(false);
    const reloaded = run(
      [{ type: 'loaded', data: { ...data, suggested: false }, notice: 'Pipeline saved.' }],
      saved
    );
    expect(reloaded.spec?.checks).toEqual([]);
    expect(canSave(reloaded)).toBe(false);
  });

  it('a pull request opened is linked, and one updated says so', () => {
    const opened = run(
      [
        { type: 'sent', busy: 'pull-request' },
        {
          type: 'pullRequestOpened',
          url: 'https://github.com/acme/sync-worker/pull/7',
          updated: false,
        },
      ],
      loaded
    );
    expect(opened).toMatchObject({
      pullRequest: { url: 'https://github.com/acme/sync-worker/pull/7', updated: false },
      notice: 'Pull request opened with the pipeline.',
    });
    expect(canSave(opened)).toBe(false);
    expect(run([{ type: 'pullRequestOpened', url: 'u', updated: true }], loaded).notice).toBe(
      'The pull request has the new file.'
    );
  });

  it('a pull request that made missing environment branches says so', () => {
    const opened = run(
      [
        { type: 'sent', busy: 'pull-request' },
        { type: 'pullRequestOpened', url: 'https://x/pr/1', updated: false, created: ['develop'] },
      ],
      loaded
    );
    expect(opened.notice).toBe(
      'Pull request opened with the pipeline. develop did not exist, so it was made from main.'
    );
    expect(pullRequestNotice(loaded, true, ['develop', 'staging'])).toBe(
      'The pull request has the new file. develop, staging did not exist, so they were made from main.'
    );
  });

  it('a refusal keeps the pipeline as edited, with the host’s words and each problem', () => {
    const refused = run(
      [
        { type: 'sent', busy: 'pull-request' },
        { type: 'failed', error: 'GitHub refused the branch renkei/pipeline: 403', problems: [] },
      ],
      loaded
    );
    expect(refused).toMatchObject({
      busy: null,
      error: 'GitHub refused the branch renkei/pipeline: 403',
    });
    expect(refused.spec).toEqual(data.spec);
  });

  it('a missing variable is called out, and the pull request can still open', () => {
    const state = run([
      { type: 'loaded', data: { ...data, facts: { ...data.facts, repoVariables: [] } } },
    ]);
    expect(checks(state)[0]).toEqual({
      state: 'fail',
      text: 'HEALTH_TOKEN is not set for dev, production.',
      fix: 'variables',
      variable: { name: 'HEALTH_TOKEN', secured: true, missingIn: ['dev', 'production'] },
    });
    // Each place it is missing has its own "Set", opening that set on its line.
    expect(variableLinks(checks(state)[0], 'p1')).toEqual([
      { label: 'Set for dev', href: '/deployments/p1/runs?set=HEALTH_TOKEN&in=dev&secret=1' },
      {
        label: 'Set for production',
        href: '/deployments/p1/runs?set=HEALTH_TOKEN&in=production&secret=1',
      },
    ]);
    expect(canOpenPullRequest(state)).toBe(true);
    expect(pullRequestNote(state)).toBe(
      'One check needs fixing before it runs; the pull request can open now and merge once it is.'
    );
  });
});

describe('the assistant’s pipeline, with blocks of the project’s own', () => {
  const ownDeploy = {
    key: 'deploy-sync-worker',
    name: 'Deploy sync-worker',
    description: 'Restarts the unit and checks /health.',
    version: 1,
    definition: { ...systemd, inputs: [], commands: 'sudo systemctl restart sync-worker' },
  };
  const tailored = {
    checks: [build],
    environments: [
      {
        name: 'production',
        branch: 'main',
        steps: [
          build,
          { block: 'deploy-sync-worker', version: 1, inputs: {}, target: 'onprem-workers' },
        ],
      },
    ],
    blocks: [ownDeploy],
  };
  const applied = run(
    [
      { type: 'select', step: { part: null, index: 0 } },
      { type: 'applyProposal', spec: tailored },
    ],
    loaded
  );

  it('fills the builder — nothing is saved until the person saves — and says so', () => {
    expect(applied.spec).toEqual(tailored);
    expect(applied.selected).toBeNull();
    expect(isDirty(applied)).toBe(true);
    expect(canSave(applied)).toBe(true);
    expect(applied.notice).toBe(
      'The assistant’s pipeline is in the builder. Check it, then save or open the pull request to keep it.'
    );
    expect(saveRequest(applied)).toEqual({ spec: tailored });
  });

  it('shows the project’s block in its row, marked as its own, with where it is used', () => {
    const production = partCards(applied)[1];
    expect(production.steps[1]).toMatchObject({
      name: 'Deploy sync-worker',
      kind: 'deploy',
      own: true,
      missing: false,
      newer: null,
      target: 'onprem-workers',
      summary: 'No inputs',
    });
    expect(partCards(applied)[0].steps[0].own).toBe(false);
    expect(ownBlocks(applied)).toEqual([
      {
        key: 'deploy-sync-worker',
        name: 'Deploy sync-worker',
        description: 'Restarts the unit and checks /health.',
        kind: 'deploy',
        version: 1,
        usedIn: ['production'],
      },
    ]);
  });

  it('writes the file with it, and its checks pass where the host is ready', () => {
    const file = fileText(applied);
    expect(file?.ok).toBe(true);
    if (file?.ok) {
      expect(file.value).toContain('sudo systemctl restart sync-worker');
      expect(file.value).toContain(
        '# block: deploy-sync-worker@v1, this project’s own, target onprem-workers'
      );
    }
    expect(checks(applied).filter((c) => c.state === 'fail')).toEqual([]);
  });

  it('offers the project’s blocks first in the picker, and adds one to another row', () => {
    expect(blockChoices(applied, 'production').map((c) => [c.key, c.own])).toEqual([
      ['deploy-sync-worker', true],
      ['deploy-systemd', false],
      ['go-lint', false],
      ['go-test-build', false],
    ]);
    // No deploys on pull requests, the project’s own included.
    expect(blockChoices(applied, null).some((c) => c.own)).toBe(false);
    const withDev = run(
      [
        { type: 'openEnvironmentForm' },
        { type: 'addEnvironment' },
        { type: 'removeStep', step: { part: 'dev', index: 1 } },
        { type: 'addStep', part: 'dev', block: 'deploy-sync-worker' },
      ],
      applied
    );
    expect(withDev.spec?.environments[1].steps[1]).toEqual({
      block: 'deploy-sync-worker',
      version: 1,
      inputs: {},
      target: 'onprem-workers',
    });
    expect(ownBlocks(withDev)[0].usedIn).toEqual(['production', 'dev']);
  });
});
