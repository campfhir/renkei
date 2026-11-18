/**
 * The pipeline builder (pipeline-builder.tsx): a code project's pipeline as
 * rows of the organization's blocks — the pull-request checks, then each
 * environment's branch and steps — the file it writes for the project's
 * host, the checks before it runs, and what Save and "Open a pull request"
 * send. Tested in pipeline-builder.model.test.ts.
 *
 * The file and the checks are @renkei/ci-blocks' own (renderPipeline,
 * pipelineChecks), worked out here from the page's data as the person
 * edits, the same as the server works them out when the pull request
 * opens.
 */

import {
  HOST_LABEL,
  partName,
  pipelineChecks,
  renderPipeline,
  type BlockKind,
  type CheckTarget,
  type Host,
  type HostFacts,
  type PipelineBlock,
  type PipelineCheck,
  type PipelineSpec,
  type PipelineStep,
  type Read,
} from '@renkei/ci-blocks';

/** What GET /api/code/projects/[id]/pipeline-builder answers. */
export interface BuilderData {
  host: Host;
  file: string;
  spec: PipelineSpec;
  suggested: boolean;
  found: string[];
  blocks: (PipelineBlock & { description: string | null })[];
  targets: CheckTarget[];
  facts: HostFacts;
  unread: string[];
  pullRequestUrl: string | null;
  canEdit: boolean;
  project: { name: string; repo: string; branch: string };
}

/** Which row: null for the pull-request checks, else an environment's name. */
export type Part = string | null;

export interface StepRef {
  part: Part;
  index: number;
}

export interface BuilderState {
  data: BuilderData | null;
  /** The pipeline as edited. */
  spec: PipelineSpec | null;
  /** As last saved; null while it is only a suggestion. */
  saved: PipelineSpec | null;
  view: 'builder' | 'file';
  /** The step whose inputs are open below its row. */
  selected: StepRef | null;
  /** The row whose block picker is open. */
  picking: { part: Part } | null;
  environmentForm: { name: string; branch: string } | null;
  busy: 'load' | 'save' | 'pull-request' | null;
  error: string | null;
  problems: string[];
  notice: string | null;
  pullRequest: { url: string; updated: boolean } | null;
}

export type BuilderAction =
  | { type: 'sent'; busy: NonNullable<BuilderState['busy']> }
  | { type: 'loaded'; data: BuilderData; notice?: string }
  | { type: 'failed'; error: string; problems?: string[] }
  | { type: 'view'; view: BuilderState['view'] }
  | { type: 'select'; step: StepRef | null }
  | { type: 'openPicker'; part: Part }
  | { type: 'closePicker' }
  | { type: 'addStep'; part: Part; block: string }
  | { type: 'removeStep'; step: StepRef }
  | { type: 'moveStep'; step: StepRef; by: -1 | 1 }
  | { type: 'setInput'; step: StepRef; name: string; value: string }
  | { type: 'setTarget'; step: StepRef; target: string }
  | { type: 'updateStep'; step: StepRef }
  | { type: 'setBranch'; environment: string; branch: string }
  | { type: 'removeEnvironment'; environment: string }
  | { type: 'openEnvironmentForm' }
  | { type: 'environmentField'; patch: Partial<{ name: string; branch: string }> }
  | { type: 'closeEnvironmentForm' }
  | { type: 'addEnvironment' }
  | { type: 'saved' }
  | { type: 'pullRequestOpened'; url: string; updated: boolean };

export const initialBuilder: BuilderState = {
  data: null,
  spec: null,
  saved: null,
  view: 'builder',
  selected: null,
  picking: null,
  environmentForm: null,
  busy: 'load',
  error: null,
  problems: [],
  notice: null,
  pullRequest: null,
};

// ——— editing the spec ———

function latestOf(data: BuilderData, key: string): PipelineBlock | null {
  return data.blocks.filter((b) => b.key === key).sort((a, b) => b.version - a.version)[0] ?? null;
}

function stepsOf(spec: PipelineSpec, part: Part): PipelineStep[] | null {
  if (part === null) return spec.checks;
  return spec.environments.find((e) => e.name === part)?.steps ?? null;
}

function withSteps(
  spec: PipelineSpec,
  part: Part,
  change: (steps: PipelineStep[]) => PipelineStep[]
): PipelineSpec {
  if (part === null) return { ...spec, checks: change(spec.checks) };
  return {
    ...spec,
    environments: spec.environments.map((e) =>
      e.name === part ? { ...e, steps: change(e.steps) } : e
    ),
  };
}

function withStep(
  spec: PipelineSpec,
  ref: StepRef,
  change: (step: PipelineStep) => PipelineStep
): PipelineSpec {
  return withSteps(spec, ref.part, (steps) =>
    steps.map((step, index) => (index === ref.index ? change(step) : step))
  );
}

/** A target that has labels for this host and runners online, else one with labels, else none. */
function defaultTarget(data: BuilderData): string | undefined {
  const onHost = data.targets.filter((t) => t.labels[data.host].length > 0);
  return (
    onHost.find((t) => t.runners.some((r) => r.host === data.host && r.status === 'online')) ??
    onHost[0]
  )?.name;
}

/** The suggested environment for a new one: dev from develop, else staging, else a blank. */
function nextEnvironment(spec: PipelineSpec): { name: string; branch: string } {
  const has = (name: string) => spec.environments.some((e) => e.name === name);
  if (!has('dev')) return { name: 'dev', branch: 'develop' };
  if (!has('staging')) return { name: 'staging', branch: 'staging' };
  return { name: '', branch: '' };
}

function editing(state: BuilderState, spec: PipelineSpec): BuilderState {
  return { ...state, spec, notice: null, error: null, problems: [] };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  const { data, spec } = state;
  switch (action.type) {
    case 'sent':
      return { ...state, busy: action.busy, error: null, problems: [], notice: null };
    case 'loaded': {
      // A reload after a save or pull request keeps what is on screen, and
      // so does one that lands after the person started editing.
      const keep = spec !== null && (Boolean(action.notice) || isDirty(state));
      return {
        ...state,
        data: action.data,
        spec: keep ? spec : action.data.spec,
        saved:
          action.notice && spec
            ? spec
            : keep
              ? state.saved
              : action.data.suggested
                ? null
                : action.data.spec,
        busy: null,
        notice: action.notice ?? null,
      };
    }
    case 'failed':
      return { ...state, busy: null, error: action.error, problems: action.problems ?? [] };
    case 'view':
      return { ...state, view: action.view };
    case 'select':
      return { ...state, selected: action.step, picking: null };
    case 'openPicker':
      return { ...state, picking: { part: action.part }, selected: null };
    case 'closePicker':
      return { ...state, picking: null };
    case 'addStep': {
      if (!data || !spec) return state;
      const block = latestOf(data, action.block);
      const steps = stepsOf(spec, action.part);
      if (!block || !steps) return state;
      const target = block.definition.runsOn.type === 'target' ? defaultTarget(data) : undefined;
      const step: PipelineStep = {
        block: block.key,
        version: block.version,
        inputs: {},
        ...(target ? { target } : {}),
      };
      return {
        ...editing(
          state,
          withSteps(spec, action.part, (list) => [...list, step])
        ),
        picking: null,
        // Open what still needs filling in.
        selected: block.definition.inputs.some((input) => input.default === undefined)
          ? { part: action.part, index: steps.length }
          : null,
      };
    }
    case 'removeStep': {
      if (!spec) return state;
      return {
        ...editing(
          state,
          withSteps(spec, action.step.part, (list) =>
            list.filter((_, i) => i !== action.step.index)
          )
        ),
        selected: null,
      };
    }
    case 'moveStep': {
      if (!spec) return state;
      const steps = stepsOf(spec, action.step.part);
      const to = action.step.index + action.by;
      if (!steps || to < 0 || to >= steps.length) return state;
      const moved = withSteps(spec, action.step.part, (list) => {
        const next = [...list];
        [next[action.step.index], next[to]] = [next[to], next[action.step.index]];
        return next;
      });
      return { ...editing(state, moved), selected: { part: action.step.part, index: to } };
    }
    case 'setInput':
      return spec
        ? editing(
            state,
            withStep(spec, action.step, (step) => ({
              ...step,
              inputs: { ...step.inputs, [action.name]: action.value },
            }))
          )
        : state;
    case 'setTarget':
      return spec
        ? editing(
            state,
            withStep(spec, action.step, (step) => {
              const { target: _old, ...rest } = step;
              return action.target ? { ...rest, target: action.target } : rest;
            })
          )
        : state;
    case 'updateStep': {
      if (!data || !spec) return state;
      return editing(
        state,
        withStep(spec, action.step, (step) => ({
          ...step,
          version: latestOf(data, step.block)?.version ?? step.version,
        }))
      );
    }
    case 'setBranch':
      return spec
        ? editing(state, {
            ...spec,
            environments: spec.environments.map((e) =>
              e.name === action.environment ? { ...e, branch: action.branch } : e
            ),
          })
        : state;
    case 'removeEnvironment':
      return spec
        ? {
            ...editing(state, {
              ...spec,
              environments: spec.environments.filter((e) => e.name !== action.environment),
            }),
            selected: null,
          }
        : state;
    case 'openEnvironmentForm':
      return spec
        ? { ...state, environmentForm: nextEnvironment(spec), picking: null, selected: null }
        : state;
    case 'environmentField':
      return state.environmentForm
        ? { ...state, environmentForm: { ...state.environmentForm, ...action.patch } }
        : state;
    case 'closeEnvironmentForm':
      return { ...state, environmentForm: null };
    case 'addEnvironment': {
      const form = state.environmentForm;
      if (!spec || !form || environmentFormProblems(state).length > 0) return state;
      // A new environment builds as the last one does, deploy and all, ready to retarget.
      const last = spec.environments[spec.environments.length - 1];
      return {
        ...editing(state, {
          ...spec,
          environments: [
            ...spec.environments,
            { name: form.name.trim(), branch: form.branch.trim(), steps: last ? last.steps : [] },
          ],
        }),
        environmentForm: null,
      };
    }
    case 'saved':
      return { ...state, busy: null, saved: spec, notice: 'Pipeline saved.' };
    case 'pullRequestOpened':
      return {
        ...state,
        busy: null,
        saved: spec,
        pullRequest: { url: action.url, updated: action.updated },
        notice: action.updated
          ? 'The pull request has the new file.'
          : 'Pull request opened with the pipeline.',
      };
  }
}

// ——— what the page derives ———

function context(data: BuilderData) {
  return {
    host: data.host,
    block: (key: string, version: number) =>
      data.blocks.find((b) => b.key === key && b.version === version) ?? null,
    target: (name: string) => data.targets.find((t) => t.name === name)?.labels ?? null,
  };
}

/** The file as it would be written now, or every reason it cannot be yet. */
export function fileText(state: BuilderState): Read<string> | null {
  if (!state.data || !state.spec) return null;
  return renderPipeline(state.spec, context(state.data));
}

export function checks(state: BuilderState): PipelineCheck[] {
  if (!state.data || !state.spec) return [];
  const data = state.data;
  return pipelineChecks(
    state.spec,
    { at: context(data).block, latest: (key) => latestOf(data, key) },
    data.targets,
    data.facts
  );
}

export function isDirty(state: BuilderState): boolean {
  return JSON.stringify(state.spec) !== JSON.stringify(state.saved);
}

export function canSave(state: BuilderState): boolean {
  return Boolean(state.data?.canEdit) && state.busy === null && isDirty(state);
}

/** A pull request opens once the file can be written; failing checks are fixed before it merges. */
export function canOpenPullRequest(state: BuilderState): boolean {
  return Boolean(state.data?.canEdit) && state.busy === null && fileText(state)?.ok === true;
}

/** Under the button: what still needs doing before the pipeline can run. */
export function pullRequestNote(state: BuilderState): string {
  if (!state.data?.canEdit) return 'Only the project’s editors change its pipeline.';
  const file = fileText(state);
  if (file && !file.ok) return 'Fill in what the checks mark as needing fixing first.';
  const failing = checks(state).filter((c) => c.state === 'fail').length;
  if (failing === 0) return 'Merging it starts the pipeline on the branches it names.';
  return `${failing === 1 ? 'One check needs' : `${failing} checks need`} fixing before it runs; the pull request can open now and merge once ${failing === 1 ? 'it is' : 'they are'}.`;
}

export function saveRequest(state: BuilderState): { spec: PipelineSpec } | null {
  return state.spec ? { spec: state.spec } : null;
}

export interface StepCard {
  ref: StepRef;
  key: string;
  name: string;
  kind: BlockKind | null;
  /** “service_name: sync-worker · health_url: …”, or what is missing. */
  summary: string;
  target: string | null;
  /** True when the block is not among the organization's any more. */
  missing: boolean;
  /** The newer published version, when there is one. */
  newer: number | null;
  version: number;
}

export interface PartCard {
  part: Part;
  title: string;
  detail: string;
  branch: string | null;
  steps: StepCard[];
}

function stepCard(data: BuilderData, ref: StepRef, step: PipelineStep): StepCard {
  const block = context(data).block(step.block, step.version);
  const latest = latestOf(data, step.block);
  const inputs = block?.definition.inputs ?? [];
  const values = inputs.map((input) => {
    const value = step.inputs[input.name]?.trim() || input.default;
    return value === undefined ? `${input.name}: (fill in)` : `${input.name}: ${value}`;
  });
  return {
    ref,
    key: step.block,
    name: block?.name ?? step.block,
    kind: block?.definition.kind ?? null,
    summary: block
      ? values.length > 0
        ? values.join(' · ')
        : 'No inputs'
      : `The organization has no ${step.block} v${step.version}.`,
    target: block?.definition.runsOn.type === 'target' ? (step.target ?? null) : null,
    missing: !block,
    newer: latest && latest.version > step.version ? latest.version : null,
    version: step.version,
  };
}

export function partCards(state: BuilderState): PartCard[] {
  const { data, spec } = state;
  if (!data || !spec) return [];
  const card = (part: Part, steps: PipelineStep[]) =>
    steps.map((step, index) => stepCard(data, { part, index }, step));
  return [
    {
      part: null,
      title: 'On every pull request',
      detail: 'Checks only; nothing deploys.',
      branch: null,
      steps: card(null, spec.checks),
    },
    ...spec.environments.map((e) => ({
      part: e.name,
      title: `On merge to ${e.branch || '…'}`,
      detail: `Deploys environment ${e.name}.`,
      branch: e.branch,
      steps: card(e.name, e.steps),
    })),
  ];
}

/** The blocks the picker offers for a row: the latest of each, no deploys on pull requests. */
export function blockChoices(
  state: BuilderState,
  part: Part
): { key: string; name: string; kind: BlockKind; description: string | null }[] {
  const data = state.data;
  if (!data) return [];
  const keys = [...new Set(data.blocks.map((b) => b.key))];
  return keys
    .map((key) => latestOf(data, key)!)
    .filter((b) => part !== null || b.definition.kind !== 'deploy')
    .map((b) => ({
      key: b.key,
      name: b.name,
      kind: b.definition.kind,
      description: data.blocks.find((x) => x.key === b.key)?.description ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface StepEditor {
  ref: StepRef;
  name: string;
  where: string;
  fields: {
    name: string;
    type: string;
    value: string;
    placeholder: string;
    hint: string | null;
    required: boolean;
  }[];
  /** Null for a block that runs in a hosted image. */
  targets: { name: string; label: string }[] | null;
  target: string;
  canMoveBack: boolean;
  canMoveOn: boolean;
  newer: number | null;
}

export function stepEditor(state: BuilderState): StepEditor | null {
  const { data, spec, selected } = state;
  if (!data || !spec || !selected) return null;
  const steps = stepsOf(spec, selected.part);
  const step = steps?.[selected.index];
  if (!steps || !step) return null;
  const block = context(data).block(step.block, step.version);
  if (!block) return null;
  const latest = latestOf(data, step.block);
  return {
    ref: selected,
    name: block.name,
    where: `${partName(selected.part)}, step ${selected.index + 1}`,
    fields: block.definition.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      value: step.inputs[input.name] ?? '',
      placeholder: input.default ?? '',
      hint: input.description ?? null,
      required: input.default === undefined,
    })),
    targets:
      block.definition.runsOn.type === 'target'
        ? data.targets.map((t) => ({
            name: t.name,
            label:
              t.labels[data.host].length > 0
                ? t.name
                : `${t.name} (no ${HOST_LABEL[data.host]} labels)`,
          }))
        : null,
    target: step.target ?? '',
    canMoveBack: selected.index > 0,
    canMoveOn: selected.index < steps.length - 1,
    newer: latest && latest.version > step.version ? latest.version : null,
  };
}

export function environmentFormProblems(state: BuilderState): string[] {
  const form = state.environmentForm;
  if (!form || !state.spec) return [];
  const name = form.name.trim();
  const branch = form.branch.trim();
  const problems: string[] = [];
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)) {
    problems.push('Name the environment: letters, digits, - and _.');
  } else if (state.spec.environments.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    problems.push(`There is an environment named ${name} already.`);
  }
  if (!branch) problems.push('Name the branch whose merges deploy it.');
  else if (state.spec.environments.some((e) => e.branch === branch)) {
    problems.push(`${branch} deploys another environment already.`);
  }
  return problems;
}

/** The header's line about the file: what is on the branch now, and what the pull request does to it. */
export function fileStatus(state: BuilderState): string {
  const data = state.data;
  if (!data) return '';
  const facts = data.facts;
  if (facts.existingFile === null) return `No ${data.file} on ${facts.branch} yet`;
  if (facts.lastWritten !== null && facts.existingFile === facts.lastWritten) {
    return `${data.file} on ${facts.branch} is as the builder wrote it`;
  }
  return `${data.file} on ${facts.branch} was not written here`;
}

/** Lines in the file it writes, for the file tab's header. */
export function fileLines(state: BuilderState): number | null {
  const file = fileText(state);
  return file?.ok ? file.value.trimEnd().split('\n').length : null;
}
