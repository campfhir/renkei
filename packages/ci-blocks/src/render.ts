/**
 * A block, as one host's pipeline file has it: a Bitbucket Pipelines step
 * or a GitHub Actions job (definition.ts says what a block is).
 *
 * What a pipeline decides about one use of a block — its title, the
 * inputs' values, the environment a deploy block deploys, the target's
 * runner labels, the GitHub jobs it waits for — is a `BlockUse`.
 *
 * The hosts differ, and the renderer carries the difference so a block
 * need not:
 * - placeholders: `${commit}` is `$BITBUCKET_COMMIT` on one and
 *   `$GITHUB_SHA` on the other; an input is its value, written in;
 * - variables: Bitbucket hands a step its repository and deployment
 *   variables; a GitHub job maps each from `vars` or `secrets`;
 * - checkout, artifacts and caches: Bitbucket clones and passes artifacts
 *   on by itself; a GitHub job checks out, and carries an artifact as a
 *   tar so its paths arrive as they were left (upload-artifact would
 *   strip a single directory's name);
 * - where it runs: a hosted block's image is Bitbucket's `image` and
 *   GitHub's `container`; a target's labels are each host's `runs-on`.
 */

import { stringify } from 'yaml';
import type { BlockDefinition, Read } from './definition';

export type Host = 'bitbucket' | 'github';

export interface BlockUse {
  /** The step's or job's name as the host shows it. */
  title: string;
  /** The GitHub job's id (letters, digits, - and _). */
  id: string;
  /** Input values by name; an input left out takes its default. */
  inputs: Record<string, string>;
  /** The environment a deploy block deploys. */
  environment?: string;
  /** The target's runner labels on each host, for a block that runs on a target. */
  target?: { bitbucket: string[]; github: string[] };
  /** GitHub jobs this one waits for. */
  needs?: string[];
}

/** Bitbucket's own caches: a block's cache by one of these names is renamed, not redefined. */
const BITBUCKET_PREDEFINED_CACHES = new Set([
  'docker',
  'composer',
  'dotnetcore',
  'gradle',
  'ivy2',
  'maven',
  'node',
  'pip',
  'sbt',
]);

const HOST_VARIABLES: Record<Host, Record<'commit' | 'branch' | 'repo', string>> = {
  bitbucket: {
    commit: '$BITBUCKET_COMMIT',
    branch: '$BITBUCKET_BRANCH',
    repo: '$BITBUCKET_REPO_FULL_NAME',
  },
  github: { commit: '$GITHUB_SHA', branch: '$GITHUB_REF_NAME', repo: '$GITHUB_REPOSITORY' },
};

/** Each input's value for this use: as given, else its default; a required one left empty is an error. */
export function inputValues(
  definition: BlockDefinition,
  given: Record<string, string>
): Read<Record<string, string>> {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const input of definition.inputs) {
    const value = given[input.name]?.trim() || input.default;
    if (value === undefined) errors.push(`Fill in “${input.name}”.`);
    else values[input.name] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: values };
}

/** The commands with each placeholder spelled the host's way. */
export function substitute(
  commands: string,
  host: Host,
  values: Record<string, string>,
  environment: string | undefined
): string {
  return commands.replace(/\$\{([^}]*)\}/g, (whole, raw: string) => {
    const name = raw.trim();
    if (name === 'commit' || name === 'branch' || name === 'repo')
      return HOST_VARIABLES[host][name];
    if (name === 'env') return environment ?? '';
    const input = /^input\.(.+)$/.exec(name);
    return input && input[1] in values ? values[input[1]] : whole;
  });
}

function checkUse(definition: BlockDefinition, use: BlockUse): string[] {
  const errors: string[] = [];
  if (definition.runsOn.type === 'target' && !use.target) {
    errors.push(`“${use.title}” runs on a target: pick one.`);
  }
  if (definition.kind === 'deploy' && !use.environment) {
    errors.push(`“${use.title}” deploys: say which environment.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(use.id))
    errors.push(`“${use.id}” is not a usable job id.`);
  return errors;
}

/** A cache's name on Bitbucket: Bitbucket's own names are its own caches, so a block's is suffixed. */
export function bitbucketCacheName(name: string): string {
  return BITBUCKET_PREDEFINED_CACHES.has(name) ? `${name}-block` : name;
}

export interface BitbucketStep {
  /** The `- step:` item. */
  step: Record<string, unknown>;
  /** What the pipeline's `definitions.caches` must hold for it. */
  caches: Record<string, { key?: { files: string[] }; path: string }>;
}

export function renderBitbucketStep(
  definition: BlockDefinition,
  use: BlockUse
): Read<BitbucketStep> {
  const values = inputValues(definition, use.inputs);
  const errors = [...checkUse(definition, use), ...(values.ok ? [] : values.errors)];
  if (!values.ok || errors.length > 0) return { ok: false, errors };
  const caches: BitbucketStep['caches'] = {};
  for (const cache of definition.caches) {
    caches[bitbucketCacheName(cache.name)] = {
      ...(cache.keyFiles.length > 0 ? { key: { files: cache.keyFiles } } : {}),
      path: cache.path,
    };
  }
  const step: Record<string, unknown> = {
    name: use.title,
    ...(definition.runsOn.type === 'hosted'
      ? { image: definition.runsOn.image }
      : { 'runs-on': use.target?.bitbucket ?? [] }),
    ...(definition.kind === 'deploy' && use.environment ? { deployment: use.environment } : {}),
    ...(definition.caches.length > 0 ? { caches: Object.keys(caches) } : {}),
    // One script item: Bitbucket runs it as one command, so if/fi and
    // loops spanning lines work as written.
    script: [substitute(definition.commands, 'bitbucket', values.value, use.environment)],
    ...(definition.produces.length > 0
      ? { artifacts: definition.produces.flatMap((artifact) => artifact.paths) }
      : {}),
  };
  return { ok: true, value: { step: { step }, caches } };
}

export interface GithubJob {
  id: string;
  job: Record<string, unknown>;
}

function hashFiles(files: string[]): string {
  return files.length > 0
    ? `-\${{ hashFiles(${files.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ')}) }}`
    : '';
}

export function renderGithubJob(definition: BlockDefinition, use: BlockUse): Read<GithubJob> {
  const values = inputValues(definition, use.inputs);
  const errors = [...checkUse(definition, use), ...(values.ok ? [] : values.errors)];
  if (!values.ok || errors.length > 0) return { ok: false, errors };
  const env: Record<string, string> = {};
  for (const variable of definition.variables) {
    env[variable.name] = `\${{ ${variable.secured ? 'secrets' : 'vars'}.${variable.name} }}`;
  }
  const steps: Record<string, unknown>[] = [{ uses: 'actions/checkout@v4' }];
  for (const name of definition.consumes) {
    steps.push({ uses: 'actions/download-artifact@v4', with: { name } });
    steps.push({ run: `tar -xf ${name}.tar && rm ${name}.tar` });
  }
  for (const cache of definition.caches) {
    steps.push({
      uses: 'actions/cache@v4',
      with: {
        path: cache.path,
        key: `${cache.name}-\${{ runner.os }}${hashFiles(cache.keyFiles)}`,
      },
    });
  }
  steps.push({
    name: use.title,
    run: substitute(definition.commands, 'github', values.value, use.environment),
  });
  for (const artifact of definition.produces) {
    steps.push({ run: `tar -cf ${artifact.name}.tar ${artifact.paths.join(' ')}` });
    steps.push({
      uses: 'actions/upload-artifact@v4',
      with: { name: artifact.name, path: `${artifact.name}.tar` },
    });
  }
  const job: Record<string, unknown> = {
    name: use.title,
    'runs-on': definition.runsOn.type === 'hosted' ? 'ubuntu-latest' : (use.target?.github ?? []),
    ...(definition.runsOn.type === 'hosted' ? { container: definition.runsOn.image } : {}),
    ...(use.needs && use.needs.length > 0 ? { needs: use.needs } : {}),
    ...(definition.kind === 'deploy' && use.environment ? { environment: use.environment } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    steps,
  };
  return { ok: true, value: { id: use.id, job } };
}

/** A sample use, for previewing a block on its own: defaults, or each input's name in angle brackets. */
export function sampleUse(definition: BlockDefinition, title: string): BlockUse {
  const inputs: Record<string, string> = {};
  for (const input of definition.inputs) inputs[input.name] = input.default ?? `<${input.name}>`;
  return {
    title,
    id: 'block',
    inputs,
    ...(definition.kind === 'deploy' ? { environment: 'production' } : {}),
    ...(definition.runsOn.type === 'target'
      ? {
          target: {
            bitbucket: ['self.hosted', 'linux', '<target>'],
            github: ['self-hosted', 'linux', '<target>'],
          },
        }
      : {}),
  };
}

/** The YAML a host's pipeline file gets for one use of a block — a step item, or a job under `jobs:`. */
export function blockYaml(definition: BlockDefinition, host: Host, use: BlockUse): Read<string> {
  const options = { lineWidth: 0 };
  if (host === 'bitbucket') {
    const rendered = renderBitbucketStep(definition, use);
    if (!rendered.ok) return rendered;
    const caches =
      Object.keys(rendered.value.caches).length > 0
        ? `# definitions.caches in the pipeline file gains:\n${stringify(rendered.value.caches, options).replace(/^/gm, '#   ')}`
        : '';
    return { ok: true, value: `${stringify([rendered.value.step], options)}${caches}` };
  }
  const rendered = renderGithubJob(definition, use);
  if (!rendered.ok) return rendered;
  return { ok: true, value: stringify({ [rendered.value.id]: rendered.value.job }, options) };
}
