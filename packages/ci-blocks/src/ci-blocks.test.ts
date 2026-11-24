import { parse } from 'yaml';
import {
  blockYaml,
  readBlockDefinition,
  renderBitbucketStep,
  renderGithubJob,
  sampleUse,
  type BlockDefinition,
  type BlockUse,
} from './index';

/** A deploy block for a self-hosted runner, the kind most of an on-prem organization's are. */
const systemd = {
  kind: 'deploy',
  runsOn: { type: 'target' },
  inputs: [
    { name: 'service_name', type: 'text' },
    { name: 'health_url', type: 'url' },
    { name: 'keep_releases', type: 'number', default: '3' },
  ],
  variables: [],
  consumes: ['dist'],
  produces: [],
  caches: [],
  commands: [
    'release=/opt/${input.service_name}/releases/${commit}',
    'install -d "$release" && cp -r dist/. "$release/"',
    'sudo systemctl restart ${input.service_name}',
    'echo "deployed ${input.service_name} to ${env} from ${branch} of ${repo}"',
  ].join('\n'),
};

/** A hosted build that leaves an artifact and keeps a cache. */
const nodeBuild = {
  kind: 'build',
  runsOn: { type: 'hosted', image: 'node:22' },
  inputs: [],
  variables: [
    { name: 'NPM_TOKEN', secured: true },
    { name: 'NODE_ENV', secured: false },
  ],
  consumes: [],
  produces: [{ name: 'dist', paths: ['dist'] }],
  caches: [{ name: 'node', path: 'node_modules', keyFiles: ['package-lock.json'] }],
  commands: 'npm ci\nnpm run build',
};

function read(value: unknown): BlockDefinition {
  const result = readBlockDefinition(value);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.value;
}

const use = (overrides: Partial<BlockUse> = {}): BlockUse => ({
  title: 'Deploy sync-worker',
  id: 'deploy-production',
  inputs: { service_name: 'sync-worker', health_url: 'http://localhost:8080/healthz' },
  environment: 'production',
  target: {
    bitbucket: ['self.hosted', 'linux', 'onprem-workers'],
    github: ['self-hosted', 'linux', 'onprem-workers'],
  },
  needs: ['build'],
  ...overrides,
});

describe('reading a block', () => {
  it('reads a well-formed block whole', () => {
    expect(read(systemd).inputs).toEqual([
      { name: 'service_name', type: 'text' },
      { name: 'health_url', type: 'url' },
      { name: 'keep_releases', type: 'number', default: '3' },
    ]);
    expect(read(nodeBuild).runsOn).toEqual({ type: 'hosted', image: 'node:22' });
  });

  it('names every problem at once, in words a person fixes', () => {
    const result = readBlockDefinition({
      kind: 'ship',
      runsOn: { type: 'hosted', image: '' },
      inputs: [{ name: 'Service Name' }, { name: 'port', type: 'number', default: 'eighty' }],
      variables: [{ name: 'BITBUCKET_TOKEN' }, { name: 'lower' }],
      produces: [{ name: 'dist', paths: ['../outside'] }],
      commands: 'echo ${input.missing} ${build}',
    });
    expect(result.ok ? [] : result.errors).toEqual([
      'Kind must be one of build, test, package, deploy, check.',
      'A block that runs on a hosted runner needs a container image, e.g. node:22.',
      'Input “Service Name” needs a name in lower case: letters, digits and _.',
      'Input “port” is a number, but its default “eighty” is not.',
      'Variable “BITBUCKET_TOKEN” is a name the host or Renkei sets itself; choose another.',
      'Variable “lower” needs a name in upper case: letters, digits and _.',
      'Artifact “dist” needs paths inside the repository.',
      'The commands use ${input.missing}, but the block has no input “missing”.',
      'The commands use ${build}; the placeholders are ${commit}, ${branch}, ${repo}, ${env} and ${input.NAME}.',
    ]);
  });

  it('keeps ${env} to deploy blocks', () => {
    const result = readBlockDefinition({ ...nodeBuild, commands: 'echo ${env}' });
    expect(result.ok ? [] : result.errors).toEqual([
      'Only a deploy block deploys to an environment, so only it may use ${env}.',
    ]);
  });
});

describe('as a Bitbucket step', () => {
  it('runs a target block on its runner labels, deploys its environment, and spells placeholders Bitbucket’s way', () => {
    const rendered = renderBitbucketStep(read(systemd), use());
    if (!rendered.ok) throw new Error(rendered.errors.join());
    expect(rendered.value.step).toEqual({
      step: {
        name: 'Deploy sync-worker',
        'runs-on': ['self.hosted', 'linux', 'onprem-workers'],
        deployment: 'production',
        script: [
          [
            'release=/opt/sync-worker/releases/$BITBUCKET_COMMIT',
            'install -d "$release" && cp -r dist/. "$release/"',
            'sudo systemctl restart sync-worker',
            'echo "deployed sync-worker to production from $BITBUCKET_BRANCH of $BITBUCKET_REPO_FULL_NAME"',
          ].join('\n'),
        ],
      },
    });
  });

  it('runs a hosted block in its image, keeps its cache under a name Bitbucket does not own, and leaves its artifact', () => {
    const rendered = renderBitbucketStep(
      read(nodeBuild),
      use({ title: 'Build', environment: undefined })
    );
    if (!rendered.ok) throw new Error(rendered.errors.join());
    expect(rendered.value.step).toEqual({
      step: {
        name: 'Build',
        image: 'node:22',
        caches: ['node-block'],
        script: ['npm ci\nnpm run build'],
        artifacts: ['dist'],
      },
    });
    expect(rendered.value.caches).toEqual({
      'node-block': { key: { files: ['package-lock.json'] }, path: 'node_modules' },
    });
  });

  it('refuses a use missing a required input, a target or an environment', () => {
    const rendered = renderBitbucketStep(
      read(systemd),
      use({ inputs: {}, target: undefined, environment: undefined })
    );
    expect(rendered.ok ? [] : rendered.errors).toEqual([
      '“Deploy sync-worker” runs on a target: pick one.',
      '“Deploy sync-worker” deploys: say which environment.',
      'Fill in “service_name”.',
      'Fill in “health_url”.',
    ]);
  });
});

describe('as a GitHub Actions job', () => {
  it('runs a target block on its labels, behind the environment, unpacking the artifact it takes', () => {
    const rendered = renderGithubJob(read(systemd), use());
    if (!rendered.ok) throw new Error(rendered.errors.join());
    expect(rendered.value).toEqual({
      id: 'deploy-production',
      job: {
        name: 'Deploy sync-worker',
        'runs-on': ['self-hosted', 'linux', 'onprem-workers'],
        needs: ['build'],
        environment: 'production',
        steps: [
          { uses: 'actions/checkout@v4' },
          { uses: 'actions/download-artifact@v4', with: { name: 'dist' } },
          { run: 'tar -xf dist.tar && rm dist.tar' },
          {
            name: 'Deploy sync-worker',
            run: [
              'release=/opt/sync-worker/releases/$GITHUB_SHA',
              'install -d "$release" && cp -r dist/. "$release/"',
              'sudo systemctl restart sync-worker',
              'echo "deployed sync-worker to production from $GITHUB_REF_NAME of $GITHUB_REPOSITORY"',
            ].join('\n'),
          },
        ],
      },
    });
  });

  it('runs a hosted block in its container, maps variables from vars and secrets, caches by its key files and packs its artifact', () => {
    const rendered = renderGithubJob(
      read(nodeBuild),
      use({ id: 'build', title: 'Build', environment: undefined, needs: [] })
    );
    if (!rendered.ok) throw new Error(rendered.errors.join());
    expect(rendered.value.job).toEqual({
      name: 'Build',
      'runs-on': 'ubuntu-latest',
      container: 'node:22',
      env: { NPM_TOKEN: '${{ secrets.NPM_TOKEN }}', NODE_ENV: '${{ vars.NODE_ENV }}' },
      steps: [
        { uses: 'actions/checkout@v4' },
        {
          uses: 'actions/cache@v4',
          with: {
            path: 'node_modules',
            key: "node-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
          },
        },
        { name: 'Build', run: 'npm ci\nnpm run build' },
        { run: 'tar -cf dist.tar dist' },
        { uses: 'actions/upload-artifact@v4', with: { name: 'dist', path: 'dist.tar' } },
      ],
    });
  });
});

describe('the preview an admin reads', () => {
  it('renders a block alone with sample values, as valid YAML for either host', () => {
    const definition = read(systemd);
    const bitbucket = blockYaml(definition, 'bitbucket', sampleUse(definition, 'Deploy'));
    const github = blockYaml(definition, 'github', sampleUse(definition, 'Deploy'));
    if (!bitbucket.ok || !github.ok) throw new Error('did not render');
    expect(parse(bitbucket.value)).toEqual([
      expect.objectContaining({
        step: expect.objectContaining({
          'runs-on': ['self.hosted', 'linux', '<target>'],
          deployment: 'production',
        }),
      }),
    ]);
    expect(bitbucket.value).toContain('/opt/<service_name>/releases/$BITBUCKET_COMMIT');
    expect(parse(github.value).block['runs-on']).toEqual(['self-hosted', 'linux', '<target>']);
  });

  it('says which caches the pipeline file must define, on Bitbucket', () => {
    const definition = read(nodeBuild);
    const preview = blockYaml(definition, 'bitbucket', sampleUse(definition, 'Build'));
    expect(preview.ok && preview.value).toContain(
      '# definitions.caches in the pipeline file gains:\n#   node-block:'
    );
  });
});
