/**
 * A building block's editor (block-editor.tsx): the form a person fills
 * in, the definition it makes, what is wrong with it as they type, the
 * block as each host's pipeline file would get it, and what Save, Publish,
 * Discard and Delete send and leave on screen. Tested in
 * block-editor.model.test.ts.
 *
 * A draft saves as it stands; Publish is offered only once the definition
 * reads whole (@renkei/ci-blocks names what does not), and publishes what
 * is on screen — the component saves first when there is something
 * unsaved.
 */

import {
  BLOCK_KINDS,
  INPUT_TYPES,
  blockYaml,
  readBlockDefinition,
  sampleUse,
  type BlockKind,
  type Host,
  type InputType,
} from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';

export const KIND_LABELS: Record<BlockKind, string> = {
  build: 'Build',
  test: 'Test',
  package: 'Package',
  deploy: 'Deploy',
  check: 'Checks',
};

export interface InputRow {
  name: string;
  type: InputType;
  default: string;
  description: string;
}
export interface VariableRow {
  name: string;
  secured: boolean;
  /** The commands run without it, so a pipeline is not told to set it. */
  optional: boolean;
  description: string;
}
export interface ArtifactRow {
  name: string;
  /** Paths, comma- or newline-separated as typed. */
  paths: string;
}
export interface CacheRow {
  name: string;
  path: string;
  /** Key files, comma-separated as typed. */
  keyFiles: string;
}

export interface BlockForm {
  key: string;
  name: string;
  description: string;
  kind: BlockKind;
  runsOn: 'hosted' | 'target';
  image: string;
  /** A hosted block that builds or runs containers. */
  docker: boolean;
  /** Megabytes for Docker on Bitbucket, as typed; empty is Bitbucket's own 1024. */
  dockerMemory: string;
  inputs: InputRow[];
  variables: VariableRow[];
  /** Artifacts it takes, comma-separated as typed. */
  consumes: string;
  produces: ArtifactRow[];
  caches: CacheRow[];
  commands: string;
}

export interface BlockVersionView {
  version: number;
  publishedBy: string;
  publishedAt: string;
}

/** What GET /api/admin/ci-blocks/[id] answers. */
export interface BlockDetailView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: string;
  latestVersion: number;
  draft: unknown;
  published: unknown;
  versions: BlockVersionView[];
}

type Busy = 'save' | 'publish' | 'discard' | 'delete' | 'draft';

export interface BlockEditorState {
  /** Null until the block is first saved. */
  blockId: string | null;
  loading: boolean;
  loadError: string | null;
  form: BlockForm;
  /** The form as last saved or loaded; what "unsaved" compares against. */
  saved: BlockForm | null;
  latestVersion: number;
  hasDraft: boolean;
  versions: BlockVersionView[];
  host: Host;
  busy: Busy | null;
  notice: string | null;
  error: string | null;
  /** What the server said stops a publish. */
  problems: string[];
  /** Deleted: the component goes back to the list. */
  gone: boolean;
}

export type FieldName =
  'key' | 'name' | 'description' | 'image' | 'dockerMemory' | 'consumes' | 'commands';

export type BlockEditorAction =
  | { type: 'loaded'; block: BlockDetailView }
  | { type: 'loadFailed'; error: string }
  | { type: 'field'; field: FieldName; value: string }
  | { type: 'kind'; kind: BlockKind }
  | { type: 'runsOn'; runsOn: 'hosted' | 'target' }
  | { type: 'docker'; docker: boolean }
  | { type: 'addRow'; list: 'inputs' | 'variables' | 'produces' | 'caches' }
  | { type: 'removeRow'; list: 'inputs' | 'variables' | 'produces' | 'caches'; index: number }
  | { type: 'input'; index: number; patch: Partial<InputRow> }
  | { type: 'variable'; index: number; patch: Partial<VariableRow> }
  | { type: 'artifact'; index: number; patch: Partial<ArtifactRow> }
  | { type: 'cache'; index: number; patch: Partial<CacheRow> }
  | { type: 'host'; host: Host }
  | { type: 'sent'; busy: Busy }
  | { type: 'saved'; id: string }
  | { type: 'published'; version: number }
  | { type: 'discarded'; block: BlockDetailView }
  | { type: 'deleted' }
  | { type: 'failed'; error: string; problems?: string[] }
  | { type: 'drafted'; definition: unknown; name?: string; key?: string; description?: string };

export const EMPTY_FORM: BlockForm = {
  key: '',
  name: '',
  description: '',
  kind: 'build',
  runsOn: 'hosted',
  image: '',
  docker: false,
  dockerMemory: '',
  inputs: [],
  variables: [],
  consumes: '',
  produces: [],
  caches: [],
  commands: '',
};

export function initialEditor(blockId: string | null): BlockEditorState {
  return {
    blockId,
    loading: blockId !== null,
    loadError: null,
    form: EMPTY_FORM,
    saved: null,
    latestVersion: 0,
    hasDraft: false,
    versions: [],
    host: 'bitbucket',
    busy: null,
    notice: null,
    error: null,
    problems: [],
    gone: false,
  };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const splitList = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

/** A stored definition as the form shows it, around the block's own key, name and description. */
export function formFromDefinition(
  definition: unknown,
  block: { key: string; name: string; description: string | null; kind: string }
): BlockForm {
  const def = isRecord(definition) ? definition : {};
  const runsOn = isRecord(def.runsOn) ? def.runsOn : {};
  const docker = runsOn.type !== 'target' && isRecord(runsOn.docker) ? runsOn.docker : null;
  return {
    key: block.key,
    name: block.name,
    description: block.description ?? '',
    kind: BLOCK_KINDS.find((k) => k === block.kind) ?? 'build',
    runsOn: runsOn.type === 'target' ? 'target' : 'hosted',
    image: text(runsOn.image),
    docker: docker !== null,
    dockerMemory: typeof docker?.memory === 'number' ? String(docker.memory) : '',
    inputs: rows(def.inputs).map((row) => ({
      name: text(row.name),
      type: INPUT_TYPES.find((t) => t === row.type) ?? 'text',
      default: text(row.default),
      description: text(row.description),
    })),
    variables: rows(def.variables).map((row) => ({
      name: text(row.name),
      secured: row.secured === true,
      optional: row.optional === true,
      description: text(row.description),
    })),
    consumes: (Array.isArray(def.consumes) ? def.consumes.map(text) : [])
      .filter(Boolean)
      .join(', '),
    produces: rows(def.produces).map((row) => ({
      name: text(row.name),
      paths: (Array.isArray(row.paths) ? row.paths.map(text) : []).join(', '),
    })),
    caches: rows(def.caches).map((row) => ({
      name: text(row.name),
      path: text(row.path),
      keyFiles: (Array.isArray(row.keyFiles) ? row.keyFiles.map(text) : []).join(', '),
    })),
    commands: text(def.commands),
  };
}

/** The definition the form makes, as the server keeps it. */
export function definitionOf(form: BlockForm): Record<string, unknown> {
  // Docker is a hosted block's to ask for; what is typed that is no number goes as typed, to be refused by name.
  const memory = form.dockerMemory.trim();
  const docker = { ...(memory ? { memory: /^\d+$/.test(memory) ? Number(memory) : memory } : {}) };
  return {
    kind: form.kind,
    runsOn:
      form.runsOn === 'hosted'
        ? { type: 'hosted', image: form.image.trim(), ...(form.docker ? { docker } : {}) }
        : { type: 'target' },
    inputs: form.inputs.map((row) => ({
      name: row.name.trim(),
      type: row.type,
      ...(row.default.trim() ? { default: row.default.trim() } : {}),
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
    })),
    variables: form.variables.map((row) => ({
      name: row.name.trim(),
      secured: row.secured,
      ...(row.optional ? { optional: true } : {}),
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
    })),
    consumes: splitList(form.consumes),
    produces: form.produces.map((row) => ({ name: row.name.trim(), paths: splitList(row.paths) })),
    caches: form.caches.map((row) => ({
      name: row.name.trim(),
      path: row.path.trim(),
      keyFiles: splitList(row.keyFiles),
    })),
    commands: form.commands,
  };
}

function fromDetail(state: BlockEditorState, block: BlockDetailView): BlockEditorState {
  const form = formFromDefinition(block.draft ?? block.published, block);
  return {
    ...state,
    blockId: block.id,
    loading: false,
    loadError: null,
    form,
    saved: form,
    latestVersion: block.latestVersion,
    hasDraft: block.draft !== null,
    versions: block.versions,
  };
}

const NEW_ROWS = {
  inputs: (): InputRow => ({ name: '', type: 'text', default: '', description: '' }),
  variables: (): VariableRow => ({ name: '', secured: false, optional: false, description: '' }),
  produces: (): ArtifactRow => ({ name: '', paths: '' }),
  caches: (): CacheRow => ({ name: '', path: '', keyFiles: '' }),
};

function patchRow<T>(list: T[], index: number, patch: Partial<T>): T[] {
  return list.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

function editing(state: BlockEditorState, form: BlockForm): BlockEditorState {
  return { ...state, form, notice: null, problems: [] };
}

export function blockEditorReducer(
  state: BlockEditorState,
  action: BlockEditorAction
): BlockEditorState {
  switch (action.type) {
    case 'loaded':
      return fromDetail(state, action.block);
    case 'loadFailed':
      return { ...state, loading: false, loadError: action.error };
    case 'field':
      // The key names the block in every pipeline: fixed once it exists.
      if (action.field === 'key' && state.blockId) return state;
      return editing(state, { ...state.form, [action.field]: action.value });
    case 'kind':
      return editing(state, { ...state.form, kind: action.kind });
    case 'runsOn':
      return editing(state, { ...state.form, runsOn: action.runsOn });
    case 'docker':
      return editing(state, { ...state.form, docker: action.docker });
    case 'addRow':
      return editing(state, {
        ...state.form,
        [action.list]: [...state.form[action.list], NEW_ROWS[action.list]()],
      });
    case 'removeRow':
      return editing(state, {
        ...state.form,
        [action.list]: state.form[action.list].filter((_row, i) => i !== action.index),
      });
    case 'input':
      return editing(state, {
        ...state.form,
        inputs: patchRow(state.form.inputs, action.index, action.patch),
      });
    case 'variable':
      return editing(state, {
        ...state.form,
        variables: patchRow(state.form.variables, action.index, action.patch),
      });
    case 'artifact':
      return editing(state, {
        ...state.form,
        produces: patchRow(state.form.produces, action.index, action.patch),
      });
    case 'cache':
      return editing(state, {
        ...state.form,
        caches: patchRow(state.form.caches, action.index, action.patch),
      });
    case 'host':
      return { ...state, host: action.host };
    case 'sent':
      return { ...state, busy: action.busy, error: null, notice: null, problems: [] };
    case 'saved':
      return {
        ...state,
        busy: null,
        blockId: action.id,
        saved: state.form,
        hasDraft: true,
        notice: 'Draft saved. Pipelines keep using the published version until you publish.',
      };
    case 'published':
      return {
        ...state,
        busy: null,
        saved: state.form,
        hasDraft: false,
        latestVersion: action.version,
        versions: [
          { version: action.version, publishedBy: 'you', publishedAt: 'just now' },
          ...state.versions,
        ],
        notice: `Version ${action.version} is published. Pipelines built from earlier versions keep them until they are updated.`,
      };
    case 'discarded':
      return { ...fromDetail(state, action.block), busy: null, notice: 'Draft discarded.' };
    case 'deleted':
      return { ...state, busy: null, gone: true };
    case 'failed':
      return { ...state, busy: null, error: action.error, problems: action.problems ?? [] };
    case 'drafted': {
      const form = formFromDefinition(action.definition, {
        key: state.blockId ? state.form.key : (action.key ?? state.form.key),
        name: action.name ?? state.form.name,
        description: action.description ?? state.form.description,
        kind:
          isRecord(action.definition) && typeof action.definition.kind === 'string'
            ? action.definition.kind
            : state.form.kind,
      });
      return {
        ...state,
        busy: null,
        form,
        error: null,
        problems: [],
        notice: 'Drafted. Check every field before saving: nothing is saved until you do.',
      };
    }
  }
}

// ——— what the screen derives ———

/** What stops this block from being published, as the person types: the definition's problems, then the key's and name's. */
export function problemsOf(state: BlockEditorState): string[] {
  const problems: string[] = [];
  if (!state.blockId && !/^[a-z][a-z0-9-]{1,79}$/.test(state.form.key.trim())) {
    problems.push(
      'The key is how pipelines name the block: lower case letters, digits and -, starting with a letter.'
    );
  }
  if (!state.form.name.trim()) problems.push('Give the block a name.');
  const read = readBlockDefinition(definitionOf(state.form));
  if (!read.ok) problems.push(...read.errors);
  return problems;
}

/** The block as the chosen host's pipeline file would get it, with sample values; null while it does not read. */
export function previewOf(state: BlockEditorState): string | null {
  const read = readBlockDefinition(definitionOf(state.form));
  if (!read.ok) return null;
  const yaml = blockYaml(
    read.value,
    state.host,
    sampleUse(read.value, state.form.name.trim() || 'This block')
  );
  return yaml.ok ? yaml.value : null;
}

export function previewFileOf(host: Host): string {
  return host === 'bitbucket'
    ? 'bitbucket-pipelines.yml — one step'
    : '.github/workflows/*.yml — one job';
}

export function isDirty(state: BlockEditorState): boolean {
  return state.saved === null || JSON.stringify(state.saved) !== JSON.stringify(state.form);
}

/** Save draft: a name and a kind are enough; the definition may be half-finished. */
export function canSave(state: BlockEditorState): boolean {
  return (
    state.busy === null &&
    !state.loading &&
    isDirty(state) &&
    state.form.name.trim() !== '' &&
    (state.blockId !== null || /^[a-z][a-z0-9-]{1,79}$/.test(state.form.key.trim()))
  );
}

/** Publish: something new to publish, and a definition that reads whole. */
export function canPublish(state: BlockEditorState): boolean {
  return (
    state.busy === null &&
    !state.loading &&
    (isDirty(state) || state.hasDraft) &&
    problemsOf(state).length === 0
  );
}

export function publishLabel(state: BlockEditorState): string {
  return `Publish v${state.latestVersion + 1}`;
}

export function statusOf(state: BlockEditorState): string {
  if (state.latestVersion === 0) return 'Draft — not published yet';
  return state.hasDraft || isDirty(state)
    ? `v${state.latestVersion} published · unpublished changes`
    : `v${state.latestVersion} published`;
}

/** What Save sends: a new block's POST, or an existing one's PUT. */
export function saveRequest(state: BlockEditorState): {
  url: string;
  method: 'POST' | 'PUT';
  body: Record<string, unknown>;
} {
  const body = {
    name: state.form.name.trim(),
    description: state.form.description.trim() || null,
    kind: state.form.kind,
    definition: definitionOf(state.form),
  };
  return state.blockId
    ? { url: `/api/admin/ci-blocks/${state.blockId}`, method: 'PUT', body }
    : {
        url: '/api/admin/ci-blocks',
        method: 'POST',
        body: { key: state.form.key.trim(), ...body },
      };
}

/** Lines a host's notes say about where this block runs. */
export function hostNoteOf(state: BlockEditorState): string {
  if (state.form.runsOn === 'target') {
    return state.host === 'bitbucket'
      ? 'Runs on the target a pipeline picks: its Bitbucket runner labels become runs-on. Shown with sample labels.'
      : 'Runs on the target a pipeline picks: its GitHub runner labels become runs-on. Shown with sample labels.';
  }
  const docker = !state.form.docker
    ? ''
    : state.host === 'bitbucket'
      ? ' Bitbucket’s Docker service runs beside the step and puts the docker command in its container.'
      : ' Docker is the runner’s own engine, by its socket: the image has to bring the docker command.';
  return (
    (state.host === 'bitbucket'
      ? 'Runs in the image on Bitbucket’s own runners. Repository and deployment variables reach the step by themselves.'
      : 'Runs in the image as a container job on ubuntu-latest. Variables are passed from vars, secured ones from secrets.') +
    docker
  );
}
