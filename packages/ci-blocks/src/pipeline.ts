/**
 * A pipeline made of the organization's blocks, written once and rendered
 * as the whole file each host runs: `bitbucket-pipelines.yml`, or a
 * GitHub Actions workflow.
 *
 * A pipeline has two parts:
 * - checks, run on every pull request; nothing deploys;
 * - environments, each a branch whose merges deploy somewhere (usually
 *   `develop` → dev and `main` → production). Renkei never deploys:
 *   merging to the branch starts the host's pipeline, which does.
 *
 * Each part is a row of steps, run in order; a step is one use of a
 * block at the version it was picked at, with its inputs and, for a block
 * that runs on a target, the target's name.
 *
 * Beside the renderers: what to check before the file runs, against what
 * the host says (pipelineChecks), and a first pipeline suggested from the
 * repository's files (suggestPipeline).
 */

import { Document, isMap, isScalar, isSeq } from 'yaml';
import { isRecord } from '@renkei/guards';
import { readBlockDefinition, trimDashes, type BlockDefinition, type Read } from './definition';
import { renderBitbucketStep, renderGithubJob, type BlockUse, type Host } from './render';
import { BITBUCKET_OUTCOME, GITHUB_OUTCOME, reportCommand, type ReportTo } from './report';
import type { Runner, TargetLabels } from './targets';

export interface PipelineStep {
  /** The block's key. */
  block: string;
  /** The block's published version it was picked at. */
  version: number;
  /** Input values by name; one left out takes the block's default. */
  inputs: Record<string, string>;
  /** The target's name, for a block that runs on one. */
  target?: string;
}

export interface PipelineEnvironment {
  /** As the host names it: `dev`, `production`. */
  name: string;
  /** The branch whose merges deploy it. */
  branch: string;
  steps: PipelineStep[];
}

export interface PipelineSpec {
  /** Run on every pull request; nothing deploys. */
  checks: PipelineStep[];
  environments: PipelineEnvironment[];
  /**
   * Blocks of this project's own — written for its source (the pipeline
   * builder's assistant drafts them) and kept with its pipeline, not in
   * the organization's catalogue. A step names one by its key, and it
   * comes before an organization block of the same key; its version is
   * the draft's, and a step uses whichever the pipeline holds. Left out
   * when there are none.
   */
  blocks?: ProjectBlock[];
}

/** A block as the pipeline needs it: what the store keeps at one version. */
export interface PipelineBlock {
  key: string;
  name: string;
  version: number;
  definition: BlockDefinition;
  /** True for a block of the project's own (PipelineSpec.blocks). */
  project?: true;
}

/** A block of the project's own, as its pipeline keeps it. */
export interface ProjectBlock {
  key: string;
  name: string;
  /** What it does, and anything a person must check. */
  description?: string;
  version: number;
  definition: BlockDefinition;
}

export interface PipelineContext {
  host: Host;
  /** The block at that version, or null when the organization has no such block. */
  block: (key: string, version: number) => PipelineBlock | null;
  /** A target's labels by its name, or null when there is no such target. */
  target: (name: string) => TargetLabels | null;
  /** Where each deploy step reports to (report.ts); none writes no reports. */
  report?: ReportTo | null;
}

export const PIPELINE_FILE: Record<Host, string> = {
  bitbucket: 'bitbucket-pipelines.yml',
  github: '.github/workflows/pipeline.yml',
};

export const HOST_LABEL: Record<Host, string> = { bitbucket: 'Bitbucket', github: 'GitHub' };

const FILE_HEADER =
  ' Built in Renkei from the organization’s blocks, in the project’s pipeline builder.\n' +
  ' Change it there: the builder writes the whole file again, so an edit made here is replaced.';

const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const BRANCH_NAME = /^(?!\/|.*\/\/|.*\.\.|.*\/$)[A-Za-z0-9._/-]{1,200}$/;
const BLOCK_KEY = /^[a-z][a-z0-9-]{0,79}$/;
export const MAX_STEPS = 12;
export const MAX_ENVIRONMENTS = 6;
export const MAX_PROJECT_BLOCKS = 12;

/** Where a step sits, as a person would say it: “Pull requests, step 1”. */
export function partName(environment: string | null): string {
  return environment === null ? 'Pull requests' : environment;
}

// ——— reading a stored or sent pipeline ———

function readStep(value: unknown, where: string, errors: string[]): PipelineStep | null {
  if (!isRecord(value)) {
    errors.push(`${where} is not a step.`);
    return null;
  }
  const block = typeof value.block === 'string' ? value.block : '';
  const version = typeof value.version === 'number' ? value.version : NaN;
  if (!BLOCK_KEY.test(block)) errors.push(`${where} names no block.`);
  if (!Number.isInteger(version) || version < 1) errors.push(`${where} has no block version.`);
  const inputs: Record<string, string> = {};
  if (isRecord(value.inputs)) {
    for (const [name, given] of Object.entries(value.inputs)) {
      if (typeof given === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(name)) {
        inputs[name] = given.slice(0, 2000);
      }
    }
  }
  const target = typeof value.target === 'string' && value.target ? value.target : undefined;
  return { block, version, inputs, ...(target ? { target } : {}) };
}

function readSteps(value: unknown, part: string, errors: string[]): PipelineStep[] {
  const list = Array.isArray(value) ? value : [];
  if (list.length > MAX_STEPS) errors.push(`${part} has more than ${MAX_STEPS} steps.`);
  return list
    .slice(0, MAX_STEPS)
    .map((step, index) => readStep(step, `${part}, step ${index + 1},`, errors))
    .filter((step): step is PipelineStep => step !== null);
}

/** A pipeline as stored or sent, checked for shape (not against the blocks or the host). */
export function readPipelineSpec(value: unknown): Read<PipelineSpec> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['The pipeline is not one.'] };
  const checks = readSteps(value.checks, 'Pull requests', errors);
  const rawEnvironments = Array.isArray(value.environments) ? value.environments : [];
  if (rawEnvironments.length > MAX_ENVIRONMENTS) {
    errors.push(`A pipeline deploys to at most ${MAX_ENVIRONMENTS} environments.`);
  }
  const environments: PipelineEnvironment[] = [];
  const names = new Set<string>();
  const branches = new Set<string>();
  for (const raw of rawEnvironments.slice(0, MAX_ENVIRONMENTS)) {
    if (!isRecord(raw)) {
      errors.push('An environment is not one.');
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const branch = typeof raw.branch === 'string' ? raw.branch.trim() : '';
    if (!ENVIRONMENT_NAME.test(name)) {
      errors.push(
        `“${name || 'An environment'}” is not a usable environment name: letters, digits, - and _.`
      );
    } else if (names.has(name.toLowerCase())) {
      errors.push(`Two environments are named ${name}.`);
    }
    if (!BRANCH_NAME.test(branch)) {
      errors.push(`${name || 'An environment'} needs the branch whose merges deploy it.`);
    } else if (branches.has(branch)) {
      errors.push(`Two environments deploy from ${branch}; each needs a branch of its own.`);
    }
    names.add(name.toLowerCase());
    branches.add(branch);
    environments.push({
      name,
      branch,
      steps: readSteps(raw.steps, name || 'An environment', errors),
    });
  }
  const blocks = readProjectBlocks(value.blocks, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        value: { checks, environments, ...(blocks.length > 0 ? { blocks } : {}) },
      };
}

/** A pipeline's own blocks, each definition read whole as a published one is. */
export function readProjectBlocks(value: unknown, errors: string[]): ProjectBlock[] {
  const list = Array.isArray(value) ? value : [];
  if (list.length > MAX_PROJECT_BLOCKS) {
    errors.push(`A pipeline keeps at most ${MAX_PROJECT_BLOCKS} blocks of its own.`);
  }
  const blocks: ProjectBlock[] = [];
  for (const raw of list.slice(0, MAX_PROJECT_BLOCKS)) {
    if (!isRecord(raw)) {
      errors.push('A block of the project’s own is not one.');
      continue;
    }
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : '';
    const label = name || key || 'A block of the project’s own';
    if (!BLOCK_KEY.test(key)) {
      errors.push(
        `${label} needs a key: lower case letters, digits and -, starting with a letter.`
      );
      continue;
    }
    if (blocks.some((b) => b.key === key)) {
      errors.push(`The project has two blocks keyed ${key}.`);
      continue;
    }
    if (!name) errors.push(`The project’s block ${key} needs a name.`);
    const version =
      typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version >= 1
        ? raw.version
        : 1;
    const definition = readBlockDefinition(raw.definition);
    if (!definition.ok) {
      for (const error of definition.errors) errors.push(`${label}: ${error}`);
      continue;
    }
    const description =
      typeof raw.description === 'string' ? raw.description.trim().slice(0, 1000) : '';
    blocks.push({
      key,
      name,
      ...(description ? { description } : {}),
      version,
      definition: definition.value,
    });
  }
  return blocks;
}

/**
 * The block a step uses: the project's own of that key, at whatever
 * version the pipeline holds, else the organization's at the step's.
 */
export function blockOfStep(
  spec: PipelineSpec,
  organization: (key: string, version: number) => PipelineBlock | null
): (key: string, version: number) => PipelineBlock | null {
  return (key, version) => {
    const own = spec.blocks?.find((b) => b.key === key);
    if (own) {
      return {
        key: own.key,
        name: own.name,
        version: own.version,
        definition: own.definition,
        project: true,
      };
    }
    return organization(key, version);
  };
}

// ——— rendering ———

/** Letters, digits and -: for a GitHub job's id. */
function slug(value: string): string {
  return trimDashes(value.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 40) || 'step';
}

interface Part {
  environment: PipelineEnvironment | null;
  steps: PipelineStep[];
}

function partsOf(spec: PipelineSpec): Part[] {
  return [
    { environment: null, steps: spec.checks },
    ...spec.environments.map((environment) => ({ environment, steps: environment.steps })),
  ];
}

interface RenderedStep {
  step: PipelineStep;
  block: PipelineBlock;
  use: BlockUse;
}

/** Each part's steps resolved against the blocks and targets, or what stops each. */
function resolveParts(
  spec: PipelineSpec,
  context: PipelineContext
): Read<{ part: Part; steps: RenderedStep[]; ids: string[] }[]> {
  const errors: string[] = [];
  const taken = new Set<string>();
  const blockAt = blockOfStep(spec, context.block);
  const resolved = partsOf(spec).map((part) => {
    const prefix = part.environment ? slug(part.environment.name) : 'pull-request';
    const steps: RenderedStep[] = [];
    const ids: string[] = [];
    part.steps.forEach((step, index) => {
      const where = `${partName(part.environment?.name ?? null)}, step ${index + 1}`;
      const block = blockAt(step.block, step.version);
      if (!block) {
        errors.push(`${where}: the organization has no block ${step.block} v${step.version}.`);
        return;
      }
      let target: TargetLabels | undefined;
      if (block.definition.runsOn.type === 'target' && step.target) {
        const labels = context.target(step.target);
        if (!labels) errors.push(`${where}: there is no target named ${step.target}.`);
        else target = labels;
      }
      let id = `${prefix}-${slug(step.block)}`;
      for (let n = 2; taken.has(id); n += 1) id = `${prefix}-${slug(step.block)}-${n}`;
      taken.add(id);
      ids.push(id);
      steps.push({
        step,
        block,
        use: {
          title: block.name,
          id,
          inputs: step.inputs,
          ...(part.environment ? { environment: part.environment.name } : {}),
          ...(target ? { target } : {}),
          ...(ids.length > 1 ? { needs: [ids[ids.length - 2]] } : {}),
        },
      });
    });
    return { part, steps, ids };
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: resolved };
}

/** The same labels in two steps are written out twice, not as an anchor and an alias. */
const NO_ALIASES = { aliasDuplicateObjects: false } as const;

function marker(rendered: RenderedStep): string {
  const target = rendered.step.target ? `, target ${rendered.step.target}` : '';
  const own = rendered.block.project ? ', this project’s own' : '';
  return ` block: ${rendered.block.key}@v${rendered.block.version}${own}${target}`;
}

/** A Bitbucket deploy step that reports: signed with its own OIDC token, before and after. */
function bitbucketReporting(
  step: unknown,
  report: ReportTo,
  environment: string,
  target: string | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const given = isRecord(step) ? step : {};
  for (const [key, value] of Object.entries(given)) {
    if (key === 'script') {
      out.oidc = true;
      out.script = [
        reportCommand('bitbucket', report, environment, target, 'started', ''),
        ...(Array.isArray(value) ? value : []),
      ];
      out['after-script'] = [
        `${BITBUCKET_OUTCOME}\n${reportCommand('bitbucket', report, environment, target, '$renkei_status', '$renkei_detail')}`,
      ];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function bitbucketFile(
  parts: { part: Part; steps: RenderedStep[] }[],
  errors: string[],
  report: ReportTo | null
): string {
  const caches: Record<string, unknown> = {};
  const markers: { path: (string | number)[]; text: string }[] = [];
  const pipelines: Record<string, unknown> = {};
  const branches: Record<string, unknown[]> = {};
  for (const { part, steps } of parts) {
    const where = partName(part.environment?.name ?? null);
    const items: unknown[] = [];
    steps.forEach((rendered, index) => {
      // Bitbucket says “deployment: production”; a step only names one in a branch's pipeline.
      const out = renderBitbucketStep(rendered.block.definition, rendered.use);
      if (!out.ok) {
        errors.push(...out.errors.map((e) => `${where}, step ${index + 1}: ${e}`));
        return;
      }
      Object.assign(caches, out.value.caches);
      if (report && part.environment && rendered.block.definition.kind === 'deploy') {
        out.value.step.step = bitbucketReporting(
          out.value.step.step,
          report,
          part.environment.name,
          rendered.step.target ?? null
        );
      }
      const path = part.environment
        ? ['pipelines', 'branches', part.environment.branch, items.length]
        : ['pipelines', 'pull-requests', '**', items.length];
      markers.push({ path, text: marker(rendered) });
      items.push(out.value.step);
    });
    if (items.length === 0) continue;
    if (part.environment) branches[part.environment.branch] = items;
    else pipelines['pull-requests'] = { '**': items };
  }
  if (Object.keys(branches).length > 0) pipelines.branches = branches;
  const doc = new Document(
    { ...(Object.keys(caches).length > 0 ? { definitions: { caches } } : {}), pipelines },
    NO_ALIASES
  );
  doc.commentBefore = FILE_HEADER;
  for (const { path, text } of markers) {
    const node = doc.getIn(path, true);
    if (isMap(node) || isSeq(node)) node.commentBefore = text;
  }
  return doc.toString({ lineWidth: 0 });
}

/** A GitHub deploy job that reports: allowed an OIDC token, before its step and always after. */
function githubReporting(
  job: Record<string, unknown>,
  report: ReportTo,
  environment: string,
  target: string | null,
  title: string
): Record<string, unknown> {
  const steps = Array.isArray(job.steps) ? [...job.steps] : [];
  const main = steps.findIndex((step) => isRecord(step) && step.name === title);
  steps.splice(main < 0 ? steps.length : main, 0, {
    name: 'Tell Renkei the deploy started',
    run: reportCommand('github', report, environment, target, 'started', ''),
  });
  steps.push({
    name: 'Tell Renkei how the deploy went',
    if: 'always()',
    env: { RENKEI_JOB_STATUS: '${{ job.status }}' },
    run: `${GITHUB_OUTCOME}\n${reportCommand('github', report, environment, target, '$renkei_status', '$renkei_detail')}`,
  });
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(job)) {
    if (key === 'steps') {
      // Naming permissions takes every other away: checkout still needs to read.
      out.permissions = { contents: 'read', 'id-token': 'write' };
      out.steps = steps;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function githubFile(
  parts: { part: Part; steps: RenderedStep[]; ids: string[] }[],
  errors: string[],
  report: ReportTo | null
): string {
  const jobs: Record<string, unknown> = {};
  const markers: { id: string; text: string }[] = [];
  const branches = parts.flatMap(({ part }) => (part.environment ? [part.environment.branch] : []));
  for (const { part, steps } of parts) {
    const where = partName(part.environment?.name ?? null);
    const condition = part.environment
      ? `github.event_name == 'push' && github.ref == 'refs/heads/${part.environment.branch}'`
      : "github.event_name == 'pull_request'";
    steps.forEach((rendered, index) => {
      const out = renderGithubJob(rendered.block.definition, rendered.use);
      if (!out.ok) {
        errors.push(...out.errors.map((e) => `${where}, step ${index + 1}: ${e}`));
        return;
      }
      const { name, ...rest } = out.value.job;
      const job: Record<string, unknown> = { name, if: condition, ...rest };
      jobs[out.value.id] =
        report && part.environment && rendered.block.definition.kind === 'deploy'
          ? githubReporting(
              job,
              report,
              part.environment.name,
              rendered.step.target ?? null,
              rendered.use.title
            )
          : job;
      markers.push({ id: out.value.id, text: marker(rendered) });
    });
  }
  const on: Record<string, unknown> = {};
  if (parts.some(({ part, steps }) => !part.environment && steps.length > 0)) {
    on.pull_request = null;
  }
  if (branches.length > 0) on.push = { branches };
  const doc = new Document({ name: 'Pipeline', on, jobs }, NO_ALIASES);
  doc.commentBefore = FILE_HEADER;
  for (const { id, text } of markers) {
    const jobsNode = doc.get('jobs', true);
    if (!isMap(jobsNode)) continue;
    const pair = jobsNode.items.find((item) => String(item.key) === id);
    if (pair && isScalar(pair.key)) pair.key.commentBefore = text;
  }
  return doc.toString({ lineWidth: 0, nullStr: '' });
}

/** The whole file a host runs for this pipeline, or every reason it cannot be written yet. */
export function renderPipeline(spec: PipelineSpec, context: PipelineContext): Read<string> {
  const resolved = resolveParts(spec, context);
  if (!resolved.ok) return resolved;
  const errors: string[] = [];
  const text =
    context.host === 'bitbucket'
      ? bitbucketFile(resolved.value, errors, context.report ?? null)
      : githubFile(resolved.value, errors, context.report ?? null);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: text };
}

// ——— before it runs ———

/** What the host says, as the checks need it. */
export interface HostFacts {
  host: Host;
  /** The project's branch: where the pull request goes. */
  branch: string;
  /** The repository's variables and secrets, by name; null when they could not be read. */
  repoVariables: string[] | null;
  /** Deployment environments with their variables' and secrets' names; null when unread. */
  environments: { name: string; variables: string[] }[] | null;
  /** The repository's branches; null when unread. */
  branches: string[] | null;
  /** The pipeline file on the project's branch; null when there is none. */
  existingFile: string | null;
  /** What Renkei last wrote to that file; null when it never has. */
  lastWritten: string | null;
}

/** A target as the checks need it: its labels and its runners on this host. */
export interface CheckTarget {
  name: string;
  labels: TargetLabels;
  runners: Runner[];
}

export type CheckState = 'ok' | 'warn' | 'fail';
/** Where the page sends a person to fix it. */
export type CheckFix = 'targets' | 'variables' | 'update' | null;

export interface PipelineCheck {
  state: CheckState;
  text: string;
  fix: CheckFix;
  /** For a fix that names a step: where it is. */
  at?: { environment: string | null; index: number };
}

const lower = (value: string) => value.toLowerCase();

/** Everything to know before the file runs, worst first within each kind. */
export function pipelineChecks(
  spec: PipelineSpec,
  blocks: { latest: (key: string) => PipelineBlock | null; at: PipelineContext['block'] },
  targets: CheckTarget[],
  facts: HostFacts
): PipelineCheck[] {
  const host = facts.host;
  const hostName = HOST_LABEL[host];
  const checks: PipelineCheck[] = [];
  const add = (state: CheckState, text: string, fix: CheckFix = null, at?: PipelineCheck['at']) =>
    checks.push({ state, text, fix, ...(at ? { at } : {}) });
  const targetByName = new Map(targets.map((t) => [t.name, t]));
  const blockAt = blockOfStep(spec, blocks.at);

  // The file itself.
  const rendered = renderPipeline(spec, {
    host,
    block: blocks.at,
    target: (name) => targetByName.get(name)?.labels ?? null,
  });
  if (rendered.ok) {
    add('ok', `Every block’s inputs are filled in, and the file is written for ${hostName}.`);
  } else {
    for (const error of rendered.errors) add('fail', error);
  }

  const parts = partsOf(spec);
  const seenTargets = new Set<string>();
  const missingVariables = new Map<string, Set<string>>();
  for (const part of parts) {
    const environmentName = part.environment?.name ?? null;
    const where = partName(environmentName);
    const produced = new Set<string>();
    part.steps.forEach((step, index) => {
      const at = { environment: environmentName, index };
      const block = blockAt(step.block, step.version);
      if (!block) return; // said above
      // A project's own block has no published versions to fall behind.
      const latest = block.project ? null : blocks.latest(step.block);
      if (latest && latest.version > step.version) {
        add(
          'warn',
          `${where}: “${block.name}” is at v${step.version}; v${latest.version} is published.`,
          'update',
          at
        );
      }
      for (const artifact of block.definition.consumes) {
        if (!produced.has(artifact)) {
          add(
            'fail',
            `${where}: “${block.name}” needs the ${artifact} artifact, and no step before it in ${where} leaves one.`
          );
        }
      }
      for (const artifact of block.definition.produces) produced.add(artifact.name);

      // Its target, on this host.
      if (
        block.definition.runsOn.type === 'target' &&
        step.target &&
        !seenTargets.has(step.target)
      ) {
        const target = targetByName.get(step.target);
        if (target) {
          seenTargets.add(step.target);
          const labels = target.labels[host];
          const runners = target.runners.filter((r) => r.host === host);
          const online = runners.filter((r) => r.status === 'online').length;
          if (labels.length === 0) {
            add(
              'fail',
              `Target ${target.name} has no ${hostName} runner labels, so ${hostName} cannot run its steps.`,
              'targets'
            );
          } else if (runners.length === 0) {
            add(
              'warn',
              `No ${hostName} runner carries target ${target.name}’s labels yet; its steps wait for one.`,
              'targets'
            );
          } else if (online < runners.length) {
            add(
              online === 0 ? 'fail' : 'warn',
              `Target ${target.name} has ${online} of ${runners.length} ${hostName} runners online; its steps wait for one.`,
              'targets'
            );
          } else {
            add(
              'ok',
              `Target ${target.name}: ${runners.length === 1 ? 'its runner is' : `all ${runners.length} runners are`} online.`
            );
          }
        }
      }

      // The variables its commands read.
      if (facts.repoVariables) {
        const environment = environmentName
          ? facts.environments?.find((e) => lower(e.name) === lower(environmentName))
          : undefined;
        const has = new Set([
          ...facts.repoVariables,
          ...(environment ? environment.variables : []),
        ]);
        for (const variable of block.definition.variables) {
          if (!has.has(variable.name)) {
            const key = variable.name;
            if (!missingVariables.has(key)) missingVariables.set(key, new Set());
            missingVariables.get(key)!.add(environmentName ?? 'pull requests');
          }
        }
      }
    });
  }

  if (!facts.repoVariables) {
    add('warn', `${hostName} did not list the repository’s variables, so they were not checked.`);
  }
  for (const [name, where] of missingVariables) {
    add('fail', `${name} is not set for ${[...where].join(', ')}.`, 'variables');
  }

  // Environments and their branches.
  if (spec.environments.length === 0) {
    add('warn', 'Nothing deploys yet: add an environment, a branch that deploys somewhere.');
  }
  for (const environment of spec.environments) {
    if (facts.environments) {
      const known = facts.environments.some((e) => lower(e.name) === lower(environment.name));
      if (!known && host === 'bitbucket') {
        const names = facts.environments.map((e) => e.name).join(', ');
        add(
          'fail',
          `Bitbucket has no deployment environment named ${environment.name}: add it in the repository’s Deployments settings${names ? `, or use one it has (${names})` : ''}.`
        );
      } else if (!known) {
        add(
          'warn',
          `GitHub creates the environment ${environment.name} on its first deploy; set its variables there once it exists.`
        );
      }
    }
    if (facts.branches && !facts.branches.includes(environment.branch)) {
      add(
        'warn',
        `${environment.branch} does not exist yet: ${environment.name} deploys once it does.`
      );
    }
  }
  if (spec.checks.length === 0) {
    add('warn', 'Pull requests run nothing: add a block that tests or builds.');
  }
  const deploys = spec.environments.some((e) =>
    e.steps.some((step) => blockAt(step.block, step.version)?.definition.kind === 'deploy')
  );
  if (deploys) {
    add(
      'ok',
      `Each deploy tells Renkei how it went, signed by ${hostName} with OpenID Connect: no token is stored anywhere.`
    );
  }

  // What the pull request replaces.
  const file = PIPELINE_FILE[host];
  if (facts.existingFile === null) {
    add('ok', `${file} is a new file on ${facts.branch}.`);
  } else if (facts.lastWritten === null) {
    add(
      'warn',
      `${file} on ${facts.branch} was not written here; the pull request replaces it, and its diff shows what changes.`
    );
  } else if (facts.existingFile !== facts.lastWritten) {
    add(
      'warn',
      `${file} on ${facts.branch} was edited since the builder wrote it; the pull request replaces those edits.`
    );
  } else {
    add('ok', `${file} on ${facts.branch} is as the builder last wrote it.`);
  }

  const rank: Record<CheckState, number> = { fail: 0, warn: 1, ok: 2 };
  return checks
    .map((check, order) => ({ check, order }))
    .sort((a, b) => rank[a.check.state] - rank[b.check.state] || a.order - b.order)
    .map(({ check }) => check);
}

// ——— a first pipeline ———

const LANGUAGES: { name: string; files: RegExp }[] = [
  { name: 'go', files: /^go\.mod$/ },
  { name: 'node', files: /^package\.json$/ },
  { name: 'python', files: /^(pyproject\.toml|requirements\.txt|setup\.py)$/ },
];
const COMPOSE_FILE = /^(docker-)?compose\.ya?ml$/;

export interface Suggestion {
  spec: PipelineSpec;
  /** What was found in the repository, as the page says it: “Go · go.mod”. */
  found: string[];
}

function blocksFor(language: string, blocks: PipelineBlock[]): PipelineBlock[] {
  return blocks.filter(
    (b) =>
      (b.key.startsWith(`${language}-`) || lower(b.name).startsWith(`${language}:`)) &&
      (b.definition.kind === 'test' || b.definition.kind === 'build')
  );
}

/**
 * A first pipeline from the repository's top-level files and the
 * organization's blocks: each language's test and build blocks on pull
 * requests; dev from `develop` and production from the project's branch,
 * each building then deploying to a target that has runners on this host.
 */
export function suggestPipeline(input: {
  host: Host;
  /** File names at the repository's top level. */
  files: string[];
  /** The project's branch: production deploys from it. */
  branch: string;
  repoName: string;
  /** The organization's published blocks, at their latest versions. */
  blocks: PipelineBlock[];
  targets: CheckTarget[];
}): Suggestion {
  const found: string[] = [];
  const languages = LANGUAGES.filter((language) => {
    const file = input.files.find((f) => language.files.test(f));
    if (file)
      found.push(
        `${language.name === 'go' ? 'Go' : language.name === 'node' ? 'Node' : 'Python'} · ${file}`
      );
    return Boolean(file);
  });
  const compose = input.files.find((f) => COMPOSE_FILE.test(f));
  if (compose) found.push(compose);
  if (input.files.includes('Dockerfile')) found.push('Dockerfile');

  const picked = languages.flatMap((language) => blocksFor(language.name, input.blocks));
  const order = (b: PipelineBlock) => (b.definition.kind === 'test' ? 0 : 1);
  const checks = [...picked].sort((a, b) => order(a) - order(b));
  const builds = picked.filter((b) => b.definition.kind === 'build');
  const produced = new Set(builds.flatMap((b) => b.definition.produces.map((p) => p.name)));
  const deploys = input.blocks.filter((b) => b.definition.kind === 'deploy');
  const deploy =
    (compose && deploys.find((b) => b.key.includes('compose'))) ||
    deploys.find(
      (b) => b.definition.consumes.length > 0 && b.definition.consumes.every((c) => produced.has(c))
    ) ||
    deploys.find((b) => b.definition.consumes.length === 0) ||
    null;
  const onHost = input.targets.filter((t) => t.labels[input.host].length > 0);
  const target =
    onHost.find((t) => t.runners.some((r) => r.host === input.host && r.status === 'online')) ??
    onHost[0] ??
    null;

  const step = (block: PipelineBlock): PipelineStep => {
    const inputs: Record<string, string> = {};
    for (const field of block.definition.inputs) {
      if (/^(service|app)_name$/.test(field.name)) inputs[field.name] = input.repoName;
    }
    return {
      block: block.key,
      version: block.version,
      inputs,
      ...(block.definition.runsOn.type === 'target' && target ? { target: target.name } : {}),
    };
  };
  const environmentSteps = [...(builds.length > 0 ? builds : checks), ...(deploy ? [deploy] : [])];
  const branches = input.branch === 'develop' ? [input.branch] : ['develop', input.branch];
  const environments: PipelineEnvironment[] = branches.map((branch) => ({
    name: branch === input.branch ? 'production' : 'dev',
    branch,
    steps: environmentSteps.map(step),
  }));
  return { spec: { checks: checks.map(step), environments }, found };
}
