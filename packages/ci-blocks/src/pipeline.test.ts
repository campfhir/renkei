import { parse } from 'yaml';
import {
  pipelineChecks,
  readPipelineSpec,
  renderPipeline,
  suggestPipeline,
  type BlockDefinition,
  type CheckTarget,
  type HostFacts,
  type PipelineBlock,
  type PipelineContext,
  type PipelineSpec,
} from './index';

const goBuild: BlockDefinition = {
  kind: 'build',
  runsOn: { type: 'hosted', image: 'golang:1.23' },
  inputs: [{ name: 'packages', type: 'text', default: './...' }],
  variables: [],
  consumes: [],
  produces: [{ name: 'dist', paths: ['dist'] }],
  caches: [{ name: 'go-mod', path: '/go/pkg/mod', keyFiles: ['go.sum'] }],
  commands: 'go vet ${input.packages} && go test ${input.packages}\ngo build -o dist/ ./...',
};

const systemd: BlockDefinition = {
  kind: 'deploy',
  runsOn: { type: 'target' },
  inputs: [
    { name: 'service_name', type: 'text' },
    { name: 'health_url', type: 'url' },
  ],
  variables: [{ name: 'DEPLOY_NOTIFY_URL', secured: false }],
  consumes: ['dist'],
  produces: [],
  caches: [],
  commands: 'sudo systemctl restart ${input.service_name} # ${env}',
};

const nodeTest: BlockDefinition = {
  ...goBuild,
  kind: 'test',
  runsOn: { type: 'hosted', image: 'node:22' },
  inputs: [],
  produces: [],
  caches: [],
  commands: 'npm ci && npm test',
};

const BLOCKS: PipelineBlock[] = [
  { key: 'go-test-build', name: 'Go: vet, test, build', version: 3, definition: goBuild },
  { key: 'go-test-build', name: 'Go: vet, test, build', version: 2, definition: goBuild },
  { key: 'deploy-systemd', name: 'Deploy with systemd', version: 1, definition: systemd },
  { key: 'node-test', name: 'Node: install, lint, test', version: 1, definition: nodeTest },
];
const at = (key: string, version: number) =>
  BLOCKS.find((b) => b.key === key && b.version === version) ?? null;
const latest = (key: string) =>
  BLOCKS.filter((b) => b.key === key).sort((a, b) => b.version - a.version)[0] ?? null;

const targets: CheckTarget[] = [
  {
    name: 'onprem-workers',
    labels: {
      bitbucket: ['self.hosted', 'linux', 'onprem-workers'],
      github: ['self-hosted', 'onprem-workers'],
    },
    runners: [
      { host: 'github', id: '1', name: 'w-01', labels: [], status: 'online', busy: false },
      { host: 'github', id: '2', name: 'w-02', labels: [], status: 'offline', busy: false },
      { host: 'bitbucket', id: '3', name: 'w-03', labels: [], status: 'online', busy: false },
    ],
  },
  {
    name: 'gh-only',
    labels: { bitbucket: [], github: ['self-hosted', 'build'] },
    runners: [],
  },
];

const context = (host: 'bitbucket' | 'github'): PipelineContext => ({
  host,
  block: at,
  target: (name) => targets.find((t) => t.name === name)?.labels ?? null,
});

const build = { block: 'go-test-build', version: 3, inputs: {} };
const deploy = (target = 'onprem-workers') => ({
  block: 'deploy-systemd',
  version: 1,
  inputs: { service_name: 'sync-worker', health_url: 'http://localhost:8080/health' },
  target,
});

const spec: PipelineSpec = {
  checks: [build],
  environments: [
    { name: 'dev', branch: 'develop', steps: [build, deploy()] },
    { name: 'production', branch: 'main', steps: [build, deploy()] },
  ],
};

describe('the file each host runs', () => {
  it('Bitbucket: pull requests run the checks, each branch builds then deploys its environment', () => {
    const rendered = renderPipeline(spec, context('bitbucket'));
    if (!rendered.ok) throw new Error(rendered.errors.join('\n'));
    const file = parse(rendered.value);
    expect(Object.keys(file.definitions.caches)).toEqual(['go-mod']);
    expect(
      file.pipelines['pull-requests']['**'].map((s: { step: { name: string } }) => s.step.name)
    ).toEqual(['Go: vet, test, build']);
    const develop = file.pipelines.branches.develop.map(
      (s: { step: Record<string, unknown> }) => s.step
    );
    expect(develop.map((s: Record<string, unknown>) => s.name)).toEqual([
      'Go: vet, test, build',
      'Deploy with systemd',
    ]);
    expect(develop[1]).toMatchObject({
      'runs-on': ['self.hosted', 'linux', 'onprem-workers'],
      deployment: 'dev',
      script: ['sudo systemctl restart sync-worker # dev'],
    });
    expect(file.pipelines.branches.main[1].step.deployment).toBe('production');
    // Says where it came from, and which block each step is.
    expect(rendered.value).toMatch(/^# Built in Renkei/);
    expect(rendered.value).toContain('# block: deploy-systemd@v1, target onprem-workers');
  });

  it('GitHub: one workflow, each job gated on its event and branch, waiting for the one before it', () => {
    const rendered = renderPipeline(spec, context('github'));
    if (!rendered.ok) throw new Error(rendered.errors.join('\n'));
    const file = parse(rendered.value);
    expect(file.on).toEqual({ pull_request: null, push: { branches: ['develop', 'main'] } });
    expect(Object.keys(file.jobs)).toEqual([
      'pull-request-go-test-build',
      'dev-go-test-build',
      'dev-deploy-systemd',
      'production-go-test-build',
      'production-deploy-systemd',
    ]);
    expect(file.jobs['pull-request-go-test-build'].if).toBe("github.event_name == 'pull_request'");
    expect(file.jobs['production-deploy-systemd']).toMatchObject({
      if: "github.event_name == 'push' && github.ref == 'refs/heads/main'",
      needs: ['production-go-test-build'],
      'runs-on': ['self-hosted', 'onprem-workers'],
      environment: 'production',
    });
    expect(rendered.value).toContain('# block: go-test-build@v3');
  });

  it('says every reason it cannot be written yet, by where the step is', () => {
    const broken: PipelineSpec = {
      checks: [{ block: 'gone', version: 1, inputs: {} }],
      environments: [
        {
          name: 'dev',
          branch: 'develop',
          steps: [build, { block: 'deploy-systemd', version: 1, inputs: {}, target: 'nowhere' }],
        },
      ],
    };
    const rendered = renderPipeline(broken, context('github'));
    expect(rendered.ok ? [] : rendered.errors).toEqual([
      'Pull requests, step 1: the organization has no block gone v1.',
      'dev, step 2: there is no target named nowhere.',
    ]);
    const unfilled = renderPipeline(
      {
        checks: [],
        environments: [
          {
            name: 'dev',
            branch: 'develop',
            steps: [build, { block: 'deploy-systemd', version: 1, inputs: {} }],
          },
        ],
      },
      context('bitbucket')
    );
    expect(unfilled.ok ? [] : unfilled.errors).toEqual([
      'dev, step 2: “Deploy with systemd” runs on a target: pick one.',
      'dev, step 2: Fill in “service_name”.',
      'dev, step 2: Fill in “health_url”.',
    ]);
  });
});

describe('a pipeline as sent', () => {
  it('is read for shape, and names what is wrong', () => {
    expect(readPipelineSpec(spec)).toEqual({ ok: true, value: spec });
    const read = readPipelineSpec({
      checks: [{ block: 'Bad Key', version: 0 }],
      environments: [
        { name: 'dev', branch: 'develop', steps: [] },
        { name: 'Dev', branch: 'develop', steps: [] },
        { name: '', branch: '../x', steps: [] },
      ],
    });
    expect(read.ok ? [] : read.errors).toEqual([
      'Pull requests, step 1, names no block.',
      'Pull requests, step 1, has no block version.',
      'Two environments are named Dev.',
      'Two environments deploy from develop; each needs a branch of its own.',
      '“An environment” is not a usable environment name: letters, digits, - and _.',
      'An environment needs the branch whose merges deploy it.',
    ]);
  });
});

describe('before it runs', () => {
  const facts = (overrides: Partial<HostFacts> = {}): HostFacts => ({
    host: 'github',
    branch: 'main',
    repoVariables: ['DEPLOY_NOTIFY_URL'],
    environments: [
      { name: 'dev', variables: [] },
      { name: 'production', variables: [] },
    ],
    branches: ['develop', 'main'],
    existingFile: null,
    lastWritten: null,
    ...overrides,
  });
  const run = (s: PipelineSpec, f: HostFacts) =>
    pipelineChecks(s, { at, latest }, targets, f).map((c) => [c.state, c.text, c.fix]);

  it('passes a pipeline the host is ready for, and says a runner is down', () => {
    expect(run(spec, facts())).toEqual([
      [
        'warn',
        'Target onprem-workers has 1 of 2 GitHub runners online; its steps wait for one.',
        'targets',
      ],
      ['ok', 'Every block’s inputs are filled in, and the file is written for GitHub.', null],
      [
        'ok',
        'Each deploy tells Renkei how it went, signed by GitHub with OpenID Connect: no token is stored anywhere.',
        null,
      ],
      ['ok', '.github/workflows/pipeline.yml is a new file on main.', null],
    ]);
  });

  it('fails a missing variable per environment, a target without this host’s labels, and a missing artifact', () => {
    const s: PipelineSpec = {
      checks: [build],
      environments: [
        { name: 'dev', branch: 'develop', steps: [deploy('gh-only')] },
        { name: 'production', branch: 'main', steps: [build, deploy()] },
      ],
    };
    const checks = run(
      s,
      facts({
        host: 'bitbucket',
        repoVariables: [],
        environments: [{ name: 'Production', variables: ['DEPLOY_NOTIFY_URL'] }],
        branches: ['main'],
      })
    );
    expect(checks.filter(([state]) => state !== 'ok')).toEqual([
      [
        'fail',
        'dev: “Deploy with systemd” needs the dist artifact, and no step before it in dev leaves one.',
        null,
      ],
      [
        'fail',
        'Target gh-only has no Bitbucket runner labels, so Bitbucket cannot run its steps.',
        'targets',
      ],
      ['fail', 'DEPLOY_NOTIFY_URL is not set for dev.', 'variables'],
      [
        'fail',
        'Bitbucket has no deployment environment named dev: add it in the repository’s Deployments settings, or use one it has (Production).',
        null,
      ],
      ['warn', 'develop does not exist yet: the pull request makes it from main, and dev deploys once this pipeline reaches it.', null],
    ]);
  });

  it('offers a newer block version, and says what the pull request replaces', () => {
    const old: PipelineSpec = { ...spec, checks: [{ ...build, version: 2 }] };
    const checks = run(old, facts({ existingFile: 'edited', lastWritten: 'as written' }));
    expect(checks).toContainEqual([
      'warn',
      'Pull requests: “Go: vet, test, build” is at v2; v3 is published.',
      'update',
    ]);
    expect(checks).toContainEqual([
      'warn',
      '.github/workflows/pipeline.yml on main was edited since the builder wrote it; the pull request replaces those edits.',
      null,
    ]);
    expect(run(spec, facts({ existingFile: 'ci', lastWritten: null }))).toContainEqual([
      'warn',
      '.github/workflows/pipeline.yml on main was not written here; the pull request replaces it, and its diff shows what changes.',
      null,
    ]);
  });
});

describe('a first pipeline', () => {
  it('tests and builds the languages it finds, and deploys dev and production to a target with runners', () => {
    const suggested = suggestPipeline({
      host: 'github',
      files: ['README.md', 'go.mod', 'go.sum', 'Dockerfile'],
      branch: 'main',
      repoName: 'sync-worker',
      blocks: BLOCKS.filter((b) => b.version === latest(b.key)?.version),
      targets,
    });
    expect(suggested.found).toEqual(['Go · go.mod', 'Dockerfile']);
    expect(suggested.spec).toEqual({
      checks: [build],
      environments: [
        {
          name: 'dev',
          branch: 'develop',
          steps: [build, { ...deploy(), inputs: { service_name: 'sync-worker' } }],
        },
        {
          name: 'production',
          branch: 'main',
          steps: [build, { ...deploy(), inputs: { service_name: 'sync-worker' } }],
        },
      ],
    });
  });
});

describe('blocks of the project’s own', () => {
  const ownDeploy = {
    key: 'deploy-sync-worker',
    name: 'Deploy sync-worker',
    description: 'Restarts the unit and checks /health.',
    version: 2,
    definition: {
      ...systemd,
      inputs: [],
      commands: 'sudo systemctl restart sync-worker # ${env}\ncurl -fsS localhost:8080/health',
    },
  };
  const tailored: PipelineSpec = {
    checks: [build],
    environments: [
      {
        name: 'production',
        branch: 'main',
        steps: [
          build,
          { block: 'deploy-sync-worker', version: 2, inputs: {}, target: 'onprem-workers' },
        ],
      },
    ],
    blocks: [ownDeploy],
  };

  it('are kept with the pipeline, read whole, and left out when there are none', () => {
    expect(readPipelineSpec(tailored)).toEqual({ ok: true, value: tailored });
    const none = readPipelineSpec({ ...spec, blocks: [] });
    expect(none.ok && 'blocks' in none.value).toBe(false);
    const bad = readPipelineSpec({
      ...spec,
      blocks: [
        { key: 'Bad', name: 'Bad', version: 1, definition: systemd },
        { key: 'half', name: 'Half done', version: 1, definition: { ...systemd, commands: '' } },
        ownDeploy,
        { ...ownDeploy, name: 'Again' },
      ],
    });
    expect(bad.ok ? [] : bad.errors).toEqual([
      'Bad needs a key: lower case letters, digits and -, starting with a letter.',
      'Half done: The block needs at least one command.',
      'The project has two blocks keyed deploy-sync-worker.',
    ]);
  });

  it('render in place of the organization’s, marked as the project’s own, whatever version the step names', () => {
    const rendered = renderPipeline(
      {
        ...tailored,
        environments: [
          {
            ...tailored.environments[0],
            steps: [
              build,
              { block: 'deploy-sync-worker', version: 1, inputs: {}, target: 'onprem-workers' },
            ],
          },
        ],
      },
      context('bitbucket')
    );
    if (!rendered.ok) throw new Error(rendered.errors.join('\n'));
    expect(rendered.value).toContain('curl -fsS localhost:8080/health');
    expect(rendered.value).toContain(
      '# block: deploy-sync-worker@v2, this project’s own, target onprem-workers'
    );
  });

  it('are checked like any block, and never offered a newer published version', () => {
    const shadow: PipelineSpec = {
      checks: [{ block: 'go-test-build', version: 2, inputs: {} }],
      environments: [],
      blocks: [{ ...ownDeploy, key: 'go-test-build', definition: goBuild }],
    };
    const texts = pipelineChecks(shadow, { at, latest }, targets, {
      host: 'github',
      branch: 'main',
      repoVariables: [],
      environments: [],
      branches: ['main'],
      existingFile: null,
      lastWritten: null,
    }).map((c) => c.text);
    expect(texts.some((t) => t.includes('is published'))).toBe(false);
    expect(texts).toContain(
      'Every block’s inputs are filled in, and the file is written for GitHub.'
    );
  });
});
