/**
 * A building block: one step of a CI pipeline, written once and rendered
 * for Bitbucket Pipelines or GitHub Actions (render.ts).
 *
 * A block says what it is (`kind`), where it runs — in a container image
 * on a hosted runner, or on whatever target a pipeline picks for it (a
 * group of self-hosted runners, later a cloud service) — the inputs a
 * pipeline fills in, the repository or environment variables it reads,
 * the artifacts it takes and leaves, the caches it keeps, and its
 * commands. Commands are shell, one per line, and may use placeholders
 * each host spells its own way:
 *
 *   ${commit}  the commit being built      ${branch}  its branch
 *   ${repo}    the repository's full name  ${env}     the environment it deploys
 *   ${input.NAME}  an input's value, as the pipeline filled it in
 *
 * Variables are read as ordinary shell variables (`$REGISTRY_TOKEN`): a
 * Bitbucket step gets repository and deployment variables by itself; a
 * GitHub job is given them from `vars` or `secrets` by the renderer. A
 * variable the commands can do without is marked optional, and a pipeline
 * is not told to set it.
 *
 * A hosted block that builds or runs containers says it needs Docker: a
 * container has no engine of its own, and each host lends one its own way
 * (render.ts). A block on a target uses the engine its machine has.
 */

import { isRecord } from '@renkei/guards';

export const BLOCK_KINDS = ['build', 'test', 'package', 'deploy', 'check'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const INPUT_TYPES = ['text', 'number', 'boolean', 'url'] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export interface BlockInput {
  /** `service_name`: what `${input.service_name}` names. */
  name: string;
  type: InputType;
  /** Used when a pipeline leaves it empty; none makes the input required. */
  default?: string;
  description?: string;
}

export interface BlockVariable {
  /** `REGISTRY_TOKEN`: read as `$REGISTRY_TOKEN`. */
  name: string;
  /** A secret: a secured variable on Bitbucket, a secret on GitHub. */
  secured: boolean;
  /** The commands run without it: a pipeline that has not set it is not held up. */
  optional?: true;
  description?: string;
}

/** The Docker engine a hosted block is lent. */
export interface BlockDocker {
  /** Megabytes for the engine on Bitbucket, out of the step's 4096; unset is Bitbucket's 1024. */
  memory?: number;
}

export interface BlockArtifact {
  name: string;
  /** Paths or globs, relative to the repository. */
  paths: string[];
}

export interface BlockCache {
  /** A cache's name: `node`, `pip`, `go-build`. */
  name: string;
  /** The directory kept between runs. */
  path: string;
  /** Files whose contents decide when the cache is stale (GitHub's key): `package-lock.json`. */
  keyFiles: string[];
}

export type BlockRunsOn =
  /** In this container image on a hosted runner. */
  | { type: 'hosted'; image: string; docker?: BlockDocker }
  /** On the target a pipeline picks: a runner group's machines (no container). */
  | { type: 'target' };

export interface BlockDefinition {
  kind: BlockKind;
  runsOn: BlockRunsOn;
  inputs: BlockInput[];
  variables: BlockVariable[];
  /** Artifacts an earlier block left, by name. */
  consumes: string[];
  produces: BlockArtifact[];
  caches: BlockCache[];
  commands: string;
}

const INPUT_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IMAGE = /^[a-z0-9][a-z0-9._\-/:@]{0,199}$/;
/**
 * What Bitbucket lets its Docker service have on a standard step: no less
 * than 128 MB, and no more than leaves the step's own container 1024 of
 * the 4096 they share.
 */
export const DOCKER_MEMORY = { min: 128, max: 3072 } as const;
/** Names a host keeps for itself and a block may not shadow. */
const RESERVED_VARIABLE = /^(BITBUCKET_|GITHUB_|RUNNER_|CI$|HOME$|PATH$|RENKEI_)/;
/**
 * `${name}`. The name excludes `$`, `{` and `}` and is bounded, so each try
 * stops at the next `$` and a long run of `${${…` is read in linear time.
 */
export function placeholderPattern(): RegExp {
  return /\$\{([^${}]{0,120})\}/g;
}

/** Text with the dashes at either end taken off, without a backtracking pattern. */
export function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}
const SIMPLE_PLACEHOLDERS = new Set(['commit', 'branch', 'repo', 'env']);

export type Read<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The placeholders a block's commands use, in order of first use. */
export function placeholdersIn(commands: string): string[] {
  const seen = new Set<string>();
  for (const match of commands.matchAll(placeholderPattern())) seen.add(match[1].trim());
  return [...seen];
}

/**
 * A stored or submitted definition, checked whole: every problem is named
 * at once, in words a person fixes in the editor.
 */
export function readBlockDefinition(value: unknown): Read<BlockDefinition> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['The block’s definition is missing.'] };

  const kind = BLOCK_KINDS.find((k) => k === value.kind);
  if (!kind) errors.push(`Kind must be one of ${BLOCK_KINDS.join(', ')}.`);

  let runsOn: BlockRunsOn = { type: 'target' };
  const where = isRecord(value.runsOn) ? value.runsOn : {};
  if (where.type === 'hosted') {
    const image = text(where.image).trim();
    if (!IMAGE.test(image))
      errors.push('A block that runs on a hosted runner needs a container image, e.g. node:22.');
    runsOn = { type: 'hosted', image };
    if (isRecord(where.docker)) {
      const memory = where.docker.memory;
      if (memory === undefined || memory === null) {
        runsOn.docker = {};
      } else if (
        typeof memory === 'number' &&
        Number.isInteger(memory) &&
        memory >= DOCKER_MEMORY.min &&
        memory <= DOCKER_MEMORY.max
      ) {
        runsOn.docker = { memory };
      } else {
        errors.push(
          `Memory for Docker is a whole number of megabytes from ${DOCKER_MEMORY.min} to ${DOCKER_MEMORY.max}.`
        );
      }
    }
  } else if (where.type !== 'target') {
    errors.push('Say where the block runs: a container image on a hosted runner, or a target.');
  }

  const inputs: BlockInput[] = [];
  for (const raw of list(value.inputs)) {
    const entry = isRecord(raw) ? raw : {};
    const name = text(entry.name).trim();
    const type = INPUT_TYPES.find((t) => t === entry.type) ?? 'text';
    if (!INPUT_NAME.test(name)) {
      errors.push(
        `Input “${name || '(no name)'}” needs a name in lower case: letters, digits and _.`
      );
      continue;
    }
    if (inputs.some((i) => i.name === name)) {
      errors.push(`Input “${name}” is listed twice.`);
      continue;
    }
    const fallback = typeof entry.default === 'string' ? entry.default : undefined;
    if (
      fallback !== undefined &&
      type === 'number' &&
      fallback !== '' &&
      !Number.isFinite(Number(fallback))
    ) {
      errors.push(`Input “${name}” is a number, but its default “${fallback}” is not.`);
    }
    if (
      fallback !== undefined &&
      type === 'boolean' &&
      fallback !== '' &&
      fallback !== 'true' &&
      fallback !== 'false'
    ) {
      errors.push(`Input “${name}” is true or false, but its default is “${fallback}”.`);
    }
    inputs.push({
      name,
      type,
      ...(fallback !== undefined && fallback !== '' ? { default: fallback } : {}),
      ...(text(entry.description).trim() ? { description: text(entry.description).trim() } : {}),
    });
  }

  const variables: BlockVariable[] = [];
  for (const raw of list(value.variables)) {
    const entry = isRecord(raw) ? raw : {};
    const name = text(entry.name).trim();
    if (!VARIABLE_NAME.test(name)) {
      errors.push(
        `Variable “${name || '(no name)'}” needs a name in upper case: letters, digits and _.`
      );
      continue;
    }
    if (RESERVED_VARIABLE.test(name)) {
      errors.push(`Variable “${name}” is a name the host or Renkei sets itself; choose another.`);
      continue;
    }
    if (variables.some((v) => v.name === name)) {
      errors.push(`Variable “${name}” is listed twice.`);
      continue;
    }
    variables.push({
      name,
      secured: entry.secured === true,
      ...(entry.optional === true ? { optional: true as const } : {}),
      ...(text(entry.description).trim() ? { description: text(entry.description).trim() } : {}),
    });
  }

  const consumes: string[] = [];
  for (const raw of list(value.consumes)) {
    const name = text(raw).trim();
    if (!ARTIFACT_NAME.test(name))
      errors.push(`An artifact it takes, “${name}”, is not a usable name.`);
    else if (!consumes.includes(name)) consumes.push(name);
  }

  const produces: BlockArtifact[] = [];
  for (const raw of list(value.produces)) {
    const entry = isRecord(raw) ? raw : {};
    const name = text(entry.name).trim();
    const paths = list(entry.paths)
      .map((p) => text(p).trim())
      .filter(Boolean);
    if (!ARTIFACT_NAME.test(name)) {
      errors.push(`An artifact it leaves, “${name || '(no name)'}”, is not a usable name.`);
      continue;
    }
    if (paths.length === 0 || paths.some((p) => p.startsWith('/') || p.split('/').includes('..'))) {
      errors.push(`Artifact “${name}” needs paths inside the repository.`);
      continue;
    }
    produces.push({ name, paths });
  }

  const caches: BlockCache[] = [];
  for (const raw of list(value.caches)) {
    const entry = isRecord(raw) ? raw : {};
    const name = text(entry.name).trim();
    const path = text(entry.path).trim();
    if (!ARTIFACT_NAME.test(name) || !path) {
      errors.push(`A cache needs a name and the directory it keeps.`);
      continue;
    }
    caches.push({
      name,
      path,
      keyFiles: list(entry.keyFiles)
        .map((f) => text(f).trim())
        .filter(Boolean),
    });
  }

  const commands = text(value.commands).replace(/\r\n?/g, '\n').trim();
  if (!commands) errors.push('The block needs at least one command.');
  for (const placeholder of placeholdersIn(commands)) {
    if (SIMPLE_PLACEHOLDERS.has(placeholder)) continue;
    const input = /^input\.(.+)$/.exec(placeholder);
    if (input && inputs.some((i) => i.name === input[1])) continue;
    errors.push(
      input
        ? `The commands use \${${placeholder}}, but the block has no input “${input[1]}”.`
        : `The commands use \${${placeholder}}; the placeholders are \${commit}, \${branch}, \${repo}, \${env} and \${input.NAME}.`
    );
  }
  if (kind !== 'deploy' && placeholdersIn(commands).includes('env')) {
    errors.push('Only a deploy block deploys to an environment, so only it may use ${env}.');
  }

  if (errors.length > 0 || !kind) return { ok: false, errors };
  return {
    ok: true,
    value: { kind, runsOn, inputs, variables, consumes, produces, caches, commands },
  };
}
