/**
 * The pipeline builder (pipeline-builder.tsx): one branch's pipeline as
 * rows of the organization's blocks — the pull-request checks, then the
 * steps that deploy the environment the branch is assigned to — the file
 * it writes onto that branch for the project's host, the checks before it
 * runs, and what Save and "Open a pull request" send. Which environment a
 * branch deploys is the Environments page's (environments-page.model.ts),
 * not the builder's. Tested in pipeline-builder.model.test.ts.
 *
 * The file and the checks are @renkei/ci-blocks' own (renderPipeline,
 * pipelineChecks), worked out here from the page's data as the person
 * edits, the same as the server works them out when the pull request
 * opens.
 */

import {
  HOST_LABEL,
  blockOfStep,
  partName,
  pipelineChecks,
  renderPipeline,
  substitute,
  type BlockKind,
  type CheckTarget,
  type Host,
  type HostFacts,
  type PipelineBlock,
  type PipelineCheck,
  type PipelineSpec,
  type PipelineStep,
  type Read,
  type ReportTo,
} from '@renkei/ci-blocks';

/** What GET /api/code/projects/[id]/pipeline-builder?branch= answers. */
export interface BuilderData {
  host: Host;
  file: string;
  /** The environment the branch is assigned to: what its merges deploy. */
  environment: string;
  spec: PipelineSpec;
  suggested: boolean;
  found: string[];
  blocks: (PipelineBlock & { description: string | null })[];
  targets: CheckTarget[];
  facts: HostFacts;
  unread: string[];
  pullRequestUrl: string | null;
  /** Where each deploy step reports to; null writes no reports. */
  report: ReportTo | null;
  canEdit: boolean;
  project: { name: string; repo: string; branch: string };
  /** The pipeline files on the branch that the builder did not write, by name. */
  handwritten?: string[];
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
  /**
   * What the tab shows: the branch's own pipeline file, when it has one
   * that was not built here and nothing is saved for it here; else the
   * builder. Null until the first read says which.
   */
  mode: 'existing' | 'builder' | null;
  view: 'builder' | 'file';
  /** The step whose inputs are open below its row. */
  selected: StepRef | null;
  /** The row whose block picker is open. */
  picking: { part: Part } | null;
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
  /** Build from blocks instead of the file on the branch, or go back to that file. */
  | { type: 'mode'; mode: 'existing' | 'builder' }
  | { type: 'select'; step: StepRef | null }
  | { type: 'openPicker'; part: Part }
  | { type: 'closePicker' }
  | { type: 'addStep'; part: Part; block: string }
  | { type: 'removeStep'; step: StepRef }
  | { type: 'moveStep'; step: StepRef; by: -1 | 1 }
  | { type: 'setInput'; step: StepRef; name: string; value: string }
  | { type: 'setTarget'; step: StepRef; target: string }
  | { type: 'updateStep'; step: StepRef }
  | { type: 'saved' }
  | {
      type: 'pullRequestOpened';
      url: string;
      updated: boolean;
    }
  /** The assistant's pipeline, as the person applied it (pipeline-assistant.tsx). */
  | { type: 'applyProposal'; spec: PipelineSpec };

export const initialBuilder: BuilderState = {
  data: null,
  spec: null,
  saved: null,
  mode: null,
  view: 'builder',
  selected: null,
  picking: null,
  busy: 'load',
  error: null,
  problems: [],
  notice: null,
  pullRequest: null,
};

// ——— editing the spec ———

/** The block to add for a key: the project's own, else the organization's latest. */
function latestOf(
  data: BuilderData,
  key: string,
  spec?: PipelineSpec | null
): PipelineBlock | null {
  const own = spec?.blocks?.find((b) => b.key === key);
  if (own)
    return {
      key: own.key,
      name: own.name,
      version: own.version,
      definition: own.definition,
      project: true,
    };
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
        // Decided once, by the first read: a later one (after a save or a
        // pull request) does not move the person from where they chose to be.
        mode: state.mode ?? (opensOnExisting(action.data) ? 'existing' : 'builder'),
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
    case 'mode':
      return { ...state, mode: action.mode, selected: null, picking: null };
    case 'select':
      return { ...state, selected: action.step, picking: null };
    case 'openPicker':
      return { ...state, picking: { part: action.part }, selected: null };
    case 'closePicker':
      return { ...state, picking: null };
    case 'addStep': {
      if (!data || !spec) return state;
      const block = latestOf(data, action.block, spec);
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
          version: latestOf(data, step.block, spec)?.version ?? step.version,
        }))
      );
    }
    case 'saved':
      return { ...state, busy: null, saved: spec, notice: 'Pipeline saved.' };
    case 'applyProposal':
      return {
        ...editing(state, onItsBranch(action.spec, data)),
        view: 'builder',
        selected: null,
        picking: null,
        notice:
          'The assistant’s pipeline is in the builder. Check it, then save or open the pull request to keep it.',
      };
    case 'pullRequestOpened':
      return {
        ...state,
        busy: null,
        saved: spec,
        pullRequest: { url: action.url, updated: action.updated },
        notice: pullRequestNotice(action.updated),
      };
  }
}

// ——— what the page derives ———

/**
 * A branch whose pipeline was written elsewhere, with nothing saved for it
 * here, opens on that file: the builder would otherwise show a suggestion
 * as if nothing were there, one pull request from replacing it.
 */
export function opensOnExisting(data: BuilderData): boolean {
  return data.suggested && (data.handwritten?.length ?? 0) > 0;
}

/** The files on the branch the builder did not write; the builder offers the way back to them. */
export function existingFiles(state: BuilderState): string[] {
  return state.data?.handwritten ?? [];
}

/** What the page says once the pull request is opened or updated. */
export function pullRequestNotice(updated: boolean): string {
  return updated ? 'The pull request has the new file.' : 'Pull request opened with the pipeline.';
}

/**
 * A pipeline as this branch holds it: one environment, the one the branch
 * is assigned to. A proposal that names others keeps only this branch's
 * steps.
 */
function onItsBranch(spec: PipelineSpec, data: BuilderData | null): PipelineSpec {
  if (!data) return spec;
  const branch = data.project.branch;
  const steps =
    (
      spec.environments.find((e) => e.branch === branch) ??
      spec.environments.find((e) => e.name.toLowerCase() === data.environment.toLowerCase())
    )?.steps ?? [];
  return { ...spec, environments: [{ name: data.environment, branch, steps }] };
}

function organizationBlock(data: BuilderData) {
  return (key: string, version: number) =>
    data.blocks.find((b) => b.key === key && b.version === version) ?? null;
}

/** For the renderer and the checks, which find the project's own blocks in the spec themselves. */
function context(data: BuilderData) {
  return {
    host: data.host,
    block: organizationBlock(data),
    target: (name: string) => data.targets.find((t) => t.name === name)?.labels ?? null,
    report: data.report,
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

/**
 * Where a missing variable's "Set it" goes: the Variables tab of this
 * branch on the Environments page, told which variable, in which set (the
 * environment's, or the repository's for pull requests) and whether it is
 * a secret, so its row is there with the cursor in its value. One link
 * for each place it is missing, named by that place when there is more
 * than one.
 */
export function variableLinks(
  check: PipelineCheck,
  at: { projectId: string; environment: string; branch: string }
): { label: string; href: string }[] {
  const variable = check.variable;
  if (check.fix !== 'variables' || !variable) return [];
  return variable.missingIn.map((environment) => {
    const query = new URLSearchParams({
      env: at.environment,
      branch: at.branch,
      tab: 'variables',
      set: variable.name,
      scope: environment ? 'environment' : 'repository',
    });
    if (variable.secured) query.set('secret', '1');
    return {
      label:
        variable.missingIn.length === 1 ? 'Set it' : `Set for ${environment ?? 'the repository'}`,
      href: `/code/${at.projectId}/environments?${query.toString()}`,
    };
  });
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
  /** A block of the project's own (the assistant wrote it). */
  own: boolean;
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

function stepCard(
  data: BuilderData,
  spec: PipelineSpec,
  ref: StepRef,
  step: PipelineStep
): StepCard {
  const block = blockOfStep(spec, organizationBlock(data))(step.block, step.version);
  const latest = latestOf(data, step.block, spec);
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
    own: Boolean(block?.project),
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
    steps.map((step, index) => stepCard(data, spec, { part, index }, step));
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
      detail: `Deploys ${e.name}.`,
      branch: e.branch,
      steps: card(e.name, e.steps),
    })),
  ];
}

/** The blocks the picker offers for a row: the latest of each, no deploys on pull requests. */
export function blockChoices(
  state: BuilderState,
  part: Part
): { key: string; name: string; kind: BlockKind; description: string | null; own: boolean }[] {
  const { data, spec } = state;
  if (!data) return [];
  const own = spec?.blocks ?? [];
  const keys = [...new Set(data.blocks.map((b) => b.key))].filter(
    (key) => !own.some((b) => b.key === key)
  );
  const fits = (kind: BlockKind) => part !== null || kind !== 'deploy';
  // The project's own first, then the organization's, each by name.
  return [
    ...own
      .filter((b) => fits(b.definition.kind))
      .map((b) => ({
        key: b.key,
        name: b.name,
        kind: b.definition.kind,
        description: b.description ?? null,
        own: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...keys
      .map((key) => latestOf(data, key)!)
      .filter((b) => fits(b.definition.kind))
      .map((b) => ({
        key: b.key,
        name: b.name,
        kind: b.definition.kind,
        description: data.blocks.find((x) => x.key === b.key)?.description ?? null,
        own: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

export interface OwnBlockCard {
  key: string;
  name: string;
  description: string | null;
  kind: BlockKind;
  version: number;
  /** Where the pipeline uses it: “Pull requests”, “production”. */
  usedIn: string[];
}

/** The blocks the project keeps of its own, with where each is used. */
export function ownBlocks(state: BuilderState): OwnBlockCard[] {
  const spec = state.spec;
  if (!spec?.blocks) return [];
  const parts: { name: string; steps: PipelineStep[] }[] = [
    { name: partName(null), steps: spec.checks },
    ...spec.environments.map((e) => ({ name: e.name, steps: e.steps })),
  ];
  return spec.blocks.map((b) => ({
    key: b.key,
    name: b.name,
    description: b.description ?? null,
    kind: b.definition.kind,
    version: b.version,
    usedIn: parts.filter((p) => p.steps.some((s) => s.block === b.key)).map((p) => p.name),
  }));
}

export interface StepEditor {
  ref: StepRef;
  name: string;
  where: string;
  /** What the block says it does. */
  description: string | null;
  /** The commands this step runs, as the file gets them: inputs filled in, one still empty left as `${input.NAME}`. */
  commands: string;
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
  const block = blockOfStep(spec, organizationBlock(data))(step.block, step.version);
  if (!block) return null;
  const latest = latestOf(data, step.block, spec);
  const values: Record<string, string> = {};
  for (const input of block.definition.inputs) {
    const value = step.inputs[input.name]?.trim() || input.default;
    if (value !== undefined) values[input.name] = value;
  }
  return {
    ref: selected,
    name: block.name,
    where: `${partName(selected.part)}, step ${selected.index + 1}`,
    description:
      (
        spec.blocks?.find((b) => b.key === step.block) ??
        data.blocks.find((b) => b.key === step.block)
      )?.description ?? null,
    commands: substitute(block.definition.commands, data.host, values, selected.part ?? undefined),
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
