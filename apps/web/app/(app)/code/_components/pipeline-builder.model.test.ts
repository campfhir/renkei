import type { BlockDefinition } from '@renkei/ci-blocks';
import {
  blockChoices,
  builderReducer,
  canOpenPullRequest,
  canSave,
  checks,
  existingFiles,
  fileStatus,
  fileText,
  initialBuilder,
  isDirty,
  opensOnExisting,
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
  environment: 'production',
  spec: {
    checks: [build],
    environments: [{ name: 'production', branch: 'main', steps: [build, deploy] }],
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
    environments: [{ name: 'production', variables: [] }],
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

const at = { projectId: 'p1', environment: 'production', branch: 'main' };
const run = (actions: BuilderAction[], start: BuilderState = initialBuilder) =>
  actions.reduce(builderReducer, start);
const loaded = run([{ type: 'loaded', data }]);

describe('the suggested pipeline', () => {
  it('shows two rows: pull requests, then a merge to the branch, which deploys its environment', () => {
    expect(partCards(loaded).map((p) => [p.title, p.detail, p.steps.map((s) => s.name)])).toEqual([
      ['On every pull request', 'Checks only; nothing deploys.', ['Go: vet, test, build']],
      ['On merge to main', 'Deploys production.', ['Go: vet, test, build', 'Deploy with systemd']],
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
    expect(blockChoices(loaded, 'production').map((c) => c.key)).toEqual([
      'deploy-systemd',
      'go-lint',
      'go-test-build',
    ]);
    const added = run(
      [
        { type: 'openPicker', part: 'production' },
        { type: 'addStep', part: 'production', block: 'deploy-systemd' },
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
    expect(added.selected).toEqual({ part: 'production', index: 2 });
    // A block whose inputs all have defaults is added closed.
    expect(run([{ type: 'addStep', part: null, block: 'go-lint' }], loaded).selected).toBeNull();
  });

  it('shows what a step’s block does, and the commands it runs as the inputs are filled in', () => {
    const at = { part: 'production', index: 1 };
    const opened = run([{ type: 'select', step: at }], loaded);
    expect(stepEditor(opened)).toMatchObject({
      description: 'Restart a unit',
      commands: 'sudo systemctl restart sync-worker',
    });
    // An input emptied, with no default to fall back on, stays as the block wrote it.
    const emptied = run([{ type: 'setInput', step: at, name: 'service_name', value: '' }], opened);
    expect(stepEditor(emptied)?.commands).toBe('sudo systemctl restart ${input.service_name}');
    const filled = run(
      [{ type: 'setInput', step: at, name: 'service_name', value: 'sync' }],
      emptied
    );
    expect(stepEditor(filled)?.commands).toBe('sudo systemctl restart sync');

    // An input left empty takes its default; a block with no description shows none.
    const build = run([{ type: 'select', step: { part: 'production', index: 0 } }], loaded);
    expect(stepEditor(build)).toMatchObject({
      description: null,
      commands: 'go build -o dist/ ./...',
    });
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
    const moved = run(
      [{ type: 'moveStep', step: { part: 'production', index: 1 }, by: -1 }],
      loaded
    );
    expect(moved.spec?.environments[0].steps.map((s) => s.block)).toEqual([
      'deploy-systemd',
      'go-test-build',
    ]);
    expect(moved.selected).toEqual({ part: 'production', index: 0 });
    expect(checks(moved)[0]).toMatchObject({
      state: 'fail',
      text: 'production: “Deploy with systemd” needs the dist artifact, and no step before it in production leaves one.',
    });
    const removed = run([{ type: 'removeStep', step: { part: null, index: 0 } }], loaded);
    expect(removed.spec?.checks).toEqual([]);
    expect(checks(removed).map((c) => c.text)).toContain(
      'Pull requests run nothing: add a block that tests or builds.'
    );
  });

  it('a step left unfilled stops the pull request, and says where', () => {
    const state = run(
      [{ type: 'setInput', step: { part: 'production', index: 1 }, name: 'health_url', value: '' }],
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
      errors: [
        'production, step 2: Fill in “service_name”.',
        'production, step 2: Fill in “health_url”.',
      ],
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

describe('one branch, one environment', () => {
  it('the rows are named by the branch the file lives on and the environment it is assigned to', () => {
    const dev = run([
      {
        type: 'loaded',
        data: {
          ...data,
          environment: 'dev',
          project: { ...data.project, branch: 'develop' },
          facts: {
            ...data.facts,
            branch: 'develop',
            environments: [{ name: 'dev', variables: [] }],
          },
          spec: { checks: [build], environments: [{ name: 'dev', branch: 'develop', steps: [] }] },
        },
      },
    ]);
    expect(partCards(dev).map((p) => [p.part, p.title, p.detail])).toEqual([
      [null, 'On every pull request', 'Checks only; nothing deploys.'],
      ['dev', 'On merge to develop', 'Deploys dev.'],
    ]);
    expect(fileStatus(dev)).toBe('No .github/workflows/pipeline.yml on develop yet');
  });

  it('a proposal that names other environments keeps only this branch’s steps', () => {
    const applied = run(
      [
        {
          type: 'applyProposal',
          spec: {
            checks: [build],
            environments: [
              { name: 'dev', branch: 'develop', steps: [build] },
              { name: 'live', branch: 'main', steps: [build, deploy] },
            ],
          },
        },
      ],
      loaded
    );
    // The branch's steps, under the environment the branch is assigned to.
    expect(applied.spec?.environments).toEqual([
      { name: 'production', branch: 'main', steps: [build, deploy] },
    ]);
  });

  it('a proposal for the environment by name, on another branch, lands on this branch', () => {
    const applied = run(
      [
        {
          type: 'applyProposal',
          spec: {
            checks: [],
            environments: [{ name: 'Production', branch: 'release', steps: [build] }],
          },
        },
      ],
      loaded
    );
    expect(applied.spec?.environments).toEqual([
      { name: 'production', branch: 'main', steps: [build] },
    ]);
  });

  it('a proposal with nothing for this branch leaves its deploy row empty', () => {
    const applied = run(
      [
        {
          type: 'applyProposal',
          spec: {
            checks: [build],
            environments: [{ name: 'dev', branch: 'develop', steps: [build] }],
          },
        },
      ],
      loaded
    );
    expect(applied.spec?.environments).toEqual([{ name: 'production', branch: 'main', steps: [] }]);
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

  it('the words after a pull request are the same wherever they are said', () => {
    expect(pullRequestNotice(false)).toBe('Pull request opened with the pipeline.');
    expect(pullRequestNotice(true)).toBe('The pull request has the new file.');
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
      text: 'HEALTH_TOKEN is not set for production.',
      fix: 'variables',
      variable: { name: 'HEALTH_TOKEN', secured: true, missingIn: ['production'] },
    });
    // "Set it" opens this branch's Variables tab on the variable's row, locked as a secret.
    expect(variableLinks(checks(state)[0], at)).toEqual([
      {
        label: 'Set it',
        href: '/code/p1/environments?env=production&branch=main&tab=variables&set=HEALTH_TOKEN&scope=environment&secret=1',
      },
    ]);
    expect(canOpenPullRequest(state)).toBe(true);
    expect(pullRequestNote(state)).toBe(
      'One check needs fixing before it runs; the pull request can open now and merge once it is.'
    );
  });
});

describe('where “Set it” goes', () => {
  it('a variable pull requests need is set on the repository, plain unless it is a secret', () => {
    expect(
      variableLinks(
        {
          state: 'fail',
          text: 'NPM_REGISTRY is not set for pull requests.',
          fix: 'variables',
          variable: { name: 'NPM_REGISTRY', secured: false, missingIn: [null] },
        },
        at
      )
    ).toEqual([
      {
        label: 'Set it',
        href: '/code/p1/environments?env=production&branch=main&tab=variables&set=NPM_REGISTRY&scope=repository',
      },
    ]);
  });

  it('one missing in both places has a link for each, named by the place', () => {
    expect(
      variableLinks(
        {
          state: 'fail',
          text: 'HEALTH_TOKEN is not set for pull requests, production.',
          fix: 'variables',
          variable: { name: 'HEALTH_TOKEN', secured: true, missingIn: [null, 'production'] },
        },
        at
      ).map((link) => [link.label, new URLSearchParams(link.href.split('?')[1]).get('scope')])
    ).toEqual([
      ['Set for the repository', 'repository'],
      ['Set for production', 'environment'],
    ]);
  });

  it('a check that is not about a variable has none', () => {
    expect(variableLinks({ state: 'warn', text: 'x', fix: 'targets' }, at)).toEqual([]);
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

  it('offers the project’s blocks first in the picker, and adds one back to the row', () => {
    expect(blockChoices(applied, 'production').map((c) => [c.key, c.own])).toEqual([
      ['deploy-sync-worker', true],
      ['deploy-systemd', false],
      ['go-lint', false],
      ['go-test-build', false],
    ]);
    // No deploys on pull requests, the project’s own included.
    expect(blockChoices(applied, null).some((c) => c.own)).toBe(false);
    const again = run(
      [
        { type: 'removeStep', step: { part: 'production', index: 1 } },
        { type: 'addStep', part: 'production', block: 'deploy-sync-worker' },
      ],
      applied
    );
    expect(again.spec?.environments[0].steps[1]).toEqual({
      block: 'deploy-sync-worker',
      version: 1,
      inputs: {},
      target: 'onprem-workers',
    });
    expect(ownBlocks(again)[0].usedIn).toEqual(['production']);
  });
});

describe('a branch whose pipeline was written elsewhere', () => {
  const handwritten: BuilderData = { ...data, handwritten: ['ci.yml', 'deploy.yml'] };

  it('opens on that file, not on a suggestion one pull request from replacing it', () => {
    expect(opensOnExisting(handwritten)).toBe(true);
    const opened = run([{ type: 'loaded', data: handwritten }]);
    expect(opened.mode).toBe('existing');
    expect(existingFiles(opened)).toEqual(['ci.yml', 'deploy.yml']);
  });

  it('opens on the builder once a pipeline is saved for the branch here', () => {
    const saved: BuilderData = { ...handwritten, suggested: false };
    expect(opensOnExisting(saved)).toBe(false);
    const opened = run([{ type: 'loaded', data: saved }]);
    expect(opened.mode).toBe('builder');
    // The files are still named, for the way back to them.
    expect(existingFiles(opened)).toEqual(['ci.yml', 'deploy.yml']);
  });

  it('a branch with no pipeline of its own opens on the builder', () => {
    expect(initialBuilder.mode).toBeNull();
    expect(opensOnExisting(data)).toBe(false);
    expect(opensOnExisting({ ...data, handwritten: [] })).toBe(false);
    expect(loaded.mode).toBe('builder');
    expect(existingFiles(loaded)).toEqual([]);
    expect(existingFiles(initialBuilder)).toEqual([]);
  });

  it('building from blocks is asked for, and the file is a step back', () => {
    const opened = run([{ type: 'loaded', data: handwritten }]);
    const building = run([{ type: 'mode', mode: 'builder' }], opened);
    expect(building.mode).toBe('builder');
    // The suggestion is there to work on; nothing was saved or sent by looking.
    expect(building.spec).toEqual(handwritten.spec);
    expect(building.saved).toBeNull();
    expect(run([{ type: 'mode', mode: 'existing' }], building).mode).toBe('existing');
  });

  it('a later read does not move the person from where they chose to be', () => {
    const building = run([
      { type: 'loaded', data: handwritten },
      { type: 'mode', mode: 'builder' },
    ]);
    expect(run([{ type: 'loaded', data: handwritten }], building).mode).toBe('builder');
    // Nor does one that comes back saved move someone looking at the file.
    const onFile = run([{ type: 'loaded', data: handwritten }]);
    expect(run([{ type: 'loaded', data: { ...handwritten, suggested: false } }], onFile).mode).toBe(
      'existing'
    );
  });

  it('switching closes whatever was open in the rows', () => {
    const picking = run([
      { type: 'loaded', data: handwritten },
      { type: 'mode', mode: 'builder' },
      { type: 'openPicker', part: null },
    ]);
    expect(picking.picking).toEqual({ part: null });
    const back = run([{ type: 'mode', mode: 'existing' }], picking);
    expect(back.picking).toBeNull();
    expect(back.selected).toBeNull();
  });
});
