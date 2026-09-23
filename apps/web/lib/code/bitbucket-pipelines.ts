/**
 * A code project's Bitbucket Pipelines, for its Pipelines page and the
 * summary card on the project page: whether Pipelines is switched on for
 * the repository, whether a `bitbucket-pipelines.yml` sits on the
 * project's branch, the recent runs (and starting one), and the
 * variables the runs get — the repository's own, and each deployment
 * environment's. Read and written with the signed-in person's own grant.
 *
 * Deliberately NOT MCP tools, and never to be: a pipeline variable is
 * where a deploy key or a registry token lives, and a value the model
 * can set is a value in a transcript. A chat may write the YAML (that is
 * a file in the repository, committed like any other); the switch and
 * the variables are a person's gesture, made on the page. Bitbucket keeps
 * a secured variable's value to itself — its API never returns one —
 * and this module returns exactly what Bitbucket does, nothing kept.
 */

import { parseDotenv } from '@renkei/connector-sandbox';
import type { BitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import {
  bbJson,
  bbRawText,
  describeBitbucketFailure,
  pipelineUrl,
  rec,
  str,
  values,
} from '@/lib/mcp-tools/bitbucket/client';

/** The Bitbucket scopes each half of the page stands on (docs/bitbucket-cloud-rest-api-open-api-spec.json). */
export const PIPELINES_CONFIG_SCOPE = 'repository:admin';
export const PIPELINES_VARIABLE_SCOPE = 'pipeline:variable';
export const PIPELINES_READ_SCOPE = 'pipeline';
/**
 * Starting a run: Bitbucket asks only `pipeline`, but the connector's
 * "Run & stop pipelines" checkbox is `pipeline:write` (see
 * mcp-tools/bitbucket/scopes.ts), and a grant narrowed to reading stays
 * read-only here as it does for the chat tool.
 */
export const PIPELINES_RUN_SCOPE = 'pipeline:write';

export const PIPELINES_CONFIG_FILE = 'bitbucket-pipelines.yml';
/** Committing the file: what a code project's pushes already stand on. */
export const PIPELINES_FILE_SCOPE = 'repository:write';

/** How many runs the page lists; the card shows the newest of them. */
export const RUNS_ON_PAGE = 20;

/** Bitbucket's own rule for a variable name; the same shape as a shell's. */
const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VARIABLE_VALUE_MAX_CHARS = 32_000;

export interface PipelineVariable {
  uuid: string;
  key: string;
  /** Null for a secured variable: Bitbucket never sends one back. */
  value: string | null;
  secured: boolean;
}

export interface DeploymentEnvironment {
  uuid: string;
  name: string;
  /** Test, Staging or Production — Bitbucket's own categories. */
  type: string;
  variables: PipelineVariable[];
  /** Why the variables could not be read, when they could not. */
  error: string | null;
}

/** One pipeline run, as the page lists it. */
export interface PipelineRun {
  uuid: string;
  buildNumber: number;
  /** Bitbucket's result or stage name: SUCCESSFUL, FAILED, IN_PROGRESS, STOPPED, PENDING… */
  state: string;
  /** The branch or tag it ran on, else the commit's short hash. */
  ref: string;
  /** Who started it; empty for a scheduled or push-triggered run without a person. */
  startedBy: string;
  createdOn: string;
  durationSeconds: number | null;
  /** The run on bitbucket.org. */
  url: string;
}

export interface PipelineSetup {
  /** Null when the switch could not be read (the grant lacks repository:admin, or Bitbucket refused). */
  enabled: boolean | null;
  enabledError: string | null;
  /** Whether the YAML is on the project's branch; unknown when the branch could not be read. */
  configFile: 'present' | 'absent' | 'unknown';
  /** Newest first. */
  runs: PipelineRun[];
  runsError: string | null;
  variables: PipelineVariable[];
  variablesError: string | null;
  environments: DeploymentEnvironment[];
  environmentsError: string | null;
}

/** What the project page's card shows: the setup at a glance, and the last run. */
export interface PipelineSummary {
  enabled: boolean | null;
  enabledError: string | null;
  configFile: PipelineSetup['configFile'];
  /** The repository's variables plus every environment's; null when they could not be read. */
  variableCount: number | null;
  environmentCount: number;
  lastRun: PipelineRun | null;
  runsError: string | null;
}

export interface VariableInput {
  key: string;
  value: string;
  secured: boolean;
  /** Set for a deployment environment's variable; absent for the repository's. */
  environmentUuid?: string;
}

export function repoBase(fullName: string): string | null {
  const [workspace, slug] = fullName.split('/');
  if (!workspace || !slug) return null;
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

/** A uuid path segment the way Bitbucket wants it: in braces, then encoded. */
function uuidSegment(raw: string): string {
  const uuid = /^\{.*\}$/.test(raw) ? raw : `{${raw}}`;
  return encodeURIComponent(uuid);
}

/** Where a variable lives: the repository's set, or one environment's. */
export function variablesPath(base: string, environmentUuid: string | undefined): string {
  return environmentUuid
    ? `${base}/deployments_config/environments/${uuidSegment(environmentUuid)}/variables`
    : `${base}/pipelines_config/variables`;
}

function variableOf(raw: Record<string, unknown>): PipelineVariable | null {
  const uuid = str(raw.uuid);
  const key = str(raw.key);
  if (!uuid || !key) return null;
  const secured = raw.secured === true;
  return { uuid, key, secured, value: secured ? null : str(raw.value) };
}

/** Every page of a variables listing — a repository's or an environment's. */
export async function listVariables(
  auth: BitbucketAuth,
  path: string
): Promise<{ ok: true; variables: PipelineVariable[] } | { ok: false; error: string }> {
  const variables: PipelineVariable[] = [];
  let next: string | null = `${path}?pagelen=100`;
  for (let page = 0; next && page < 5; page += 1) {
    const listed = await bbJson(auth, [PIPELINES_READ_SCOPE], next);
    if (!listed.ok) return listed;
    for (const raw of values(listed.body)) {
      const variable = variableOf(raw);
      if (variable) variables.push(variable);
    }
    const nextUrl = str(listed.body.next);
    next = nextUrl ? nextUrl.replace(/^https?:\/\/[^/]+\/2\.0/, '') : null;
  }
  variables.sort((a, b) => a.key.localeCompare(b.key));
  return { ok: true, variables };
}

/** The switch: whether Bitbucket runs pipelines for this repository at all. */
async function readEnabled(
  auth: BitbucketAuth,
  base: string
): Promise<{ enabled: boolean | null; error: string | null }> {
  const config = await bbJson(auth, [PIPELINES_CONFIG_SCOPE], `${base}/pipelines_config`);
  if (!config.ok) return { enabled: null, error: config.error };
  return { enabled: config.body.enabled === true, error: null };
}

/** Whether the YAML is on the branch — the repository's main branch when the project names none. */
async function readConfigFile(
  auth: BitbucketAuth,
  base: string,
  branch: string
): Promise<PipelineSetup['configFile']> {
  let ref = branch;
  if (!ref) {
    const repo = await bbJson(auth, ['repository'], base);
    if (!repo.ok) return 'unknown';
    ref = str(rec(repo.body.mainbranch).name);
    if (!ref) return 'absent';
  }
  const file = await bbRawText(
    auth,
    ['repository'],
    `${base}/src/${encodeURIComponent(ref)}/${PIPELINES_CONFIG_FILE}`
  );
  if (file.ok) return file.text.trim() ? 'present' : 'absent';
  return /\b404\b/.test(file.error) ? 'absent' : 'unknown';
}

/** A run's state: its result when finished, else the stage it is in. */
function runState(raw: Record<string, unknown>): string {
  const state = rec(raw.state);
  return str(rec(state.result).name) || str(rec(state.stage).name) || str(state.name);
}

/** The newest runs — what the page lists, and the card's last run. */
async function listRuns(
  auth: BitbucketAuth,
  fullName: string,
  base: string,
  max: number
): Promise<{ ok: true; runs: PipelineRun[] } | { ok: false; error: string }> {
  const listed = await bbJson(
    auth,
    [PIPELINES_READ_SCOPE],
    `${base}/pipelines?pagelen=${max}&sort=-created_on`
  );
  if (!listed.ok) return listed;
  const runs: PipelineRun[] = [];
  for (const raw of values(listed.body)) {
    const run = runOf(fullName, raw);
    if (run) runs.push(run);
  }
  return { ok: true, runs };
}

/** One run as Bitbucket sends it, listed or just started; null without an id. */
function runOf(fullName: string, raw: Record<string, unknown>): PipelineRun | null {
  const uuid = str(raw.uuid);
  const buildNumber = typeof raw.build_number === 'number' ? raw.build_number : null;
  if (!uuid || buildNumber === null) return null;
  const [workspace, slug] = fullName.split('/');
  const target = rec(raw.target);
  return {
    uuid,
    buildNumber,
    state: runState(raw),
    ref: str(target.ref_name) || str(rec(target.commit).hash).slice(0, 12),
    startedBy: str(rec(raw.creator).display_name),
    createdOn: str(raw.created_on),
    durationSeconds: typeof raw.duration_in_seconds === 'number' ? raw.duration_in_seconds : null,
    url: pipelineUrl(workspace ?? '', slug ?? '', buildNumber),
  };
}

/** The deployment environments, each with its variables. */
async function readEnvironments(
  auth: BitbucketAuth,
  base: string
): Promise<{ environments: DeploymentEnvironment[]; error: string | null }> {
  const listed = await bbJson(auth, [PIPELINES_READ_SCOPE], `${base}/environments?pagelen=100`);
  if (!listed.ok) return { environments: [], error: listed.error };
  const found = values(listed.body)
    .map((raw) => ({
      uuid: str(raw.uuid),
      name: str(raw.name),
      type: str(rec(raw.environment_type).name),
      rank: typeof raw.rank === 'number' ? raw.rank : Number.MAX_SAFE_INTEGER,
    }))
    .filter((environment) => environment.uuid && environment.name)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const environments = await Promise.all(
    found.map(async ({ uuid, name, type }): Promise<DeploymentEnvironment> => {
      const variables = await listVariables(auth, variablesPath(base, uuid));
      return variables.ok
        ? { uuid, name, type, variables: variables.variables, error: null }
        : { uuid, name, type, variables: [], error: variables.error };
    })
  );
  return { environments, error: null };
}

/**
 * The whole setup, in one read. The switch is read only when asked:
 * its endpoint stands on repository:admin, and a connection narrowed
 * away from that is told so in the page's words rather than Bitbucket's.
 */
export async function readPipelineSetup(
  auth: BitbucketAuth,
  fullName: string,
  branch: string,
  options: { readSwitch: boolean; runs?: number }
): Promise<{ ok: true; setup: PipelineSetup } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const [switchState, configFile, runs, variables, environments] = await Promise.all([
    options.readSwitch ? readEnabled(auth, base) : { enabled: null, error: null },
    readConfigFile(auth, base, branch),
    listRuns(auth, fullName, base, options.runs ?? RUNS_ON_PAGE),
    listVariables(auth, variablesPath(base, undefined)),
    readEnvironments(auth, base),
  ]);
  return {
    ok: true,
    setup: {
      enabled: switchState.enabled,
      enabledError: switchState.error,
      configFile,
      runs: runs.ok ? runs.runs : [],
      runsError: runs.ok ? null : runs.error,
      variables: variables.ok ? variables.variables : [],
      variablesError: variables.ok ? null : variables.error,
      environments: environments.environments,
      environmentsError: environments.error,
    },
  };
}

export interface RunInput {
  /** The branch or tag to run on. */
  ref: string;
  refType: 'branch' | 'tag';
  /** A custom pipeline's name (under `custom:` in the YAML); empty runs the ref's default. */
  pattern: string;
}

const REF_MAX_CHARS = 250;

export function validateRunInput(
  input: unknown
): { ok: true; input: RunInput } | { ok: false; message: string } {
  const body = rec(input);
  const ref = str(body.ref).trim();
  if (!ref || ref.length > REF_MAX_CHARS || /[\s]/.test(ref)) {
    return { ok: false, message: 'Name the branch or tag to run on.' };
  }
  const refType = body.refType === 'tag' ? 'tag' : 'branch';
  const pattern = str(body.pattern).trim();
  if (pattern.length > REF_MAX_CHARS)
    return { ok: false, message: 'That pipeline name is too long.' };
  return { ok: true, input: { ref, refType, pattern } };
}

/** Start a run on a branch or tag — the ref's default pipeline, or a named custom one. */
export async function triggerPipeline(
  auth: BitbucketAuth,
  fullName: string,
  input: RunInput
): Promise<{ ok: true; run: PipelineRun } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const target: Record<string, unknown> = {
    type: 'pipeline_ref_target',
    ref_type: input.refType,
    ref_name: input.ref,
    ...(input.pattern ? { selector: { type: 'custom', pattern: input.pattern } } : {}),
  };
  const started = await bbJson(auth, [PIPELINES_RUN_SCOPE], `${base}/pipelines`, {
    method: 'POST',
    json: { target },
  });
  if (!started.ok) return started;
  const run = runOf(fullName, started.body);
  return run ? { ok: true, run } : { ok: false, error: 'Bitbucket did not send the run back.' };
}

/** The card's view of a setup: counts and the last run, no names or values. */
export function summarize(setup: PipelineSetup): PipelineSummary {
  const environmentVariables = setup.environments.reduce(
    (count, environment) => count + environment.variables.length,
    0
  );
  return {
    enabled: setup.enabled,
    enabledError: setup.enabledError,
    configFile: setup.configFile,
    variableCount: setup.variablesError ? null : setup.variables.length + environmentVariables,
    environmentCount: setup.environments.length,
    lastRun: setup.runs[0] ?? null,
    runsError: setup.runsError,
  };
}

export async function setPipelinesEnabled(
  auth: BitbucketAuth,
  fullName: string,
  enabled: boolean
): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const result = await bbJson(auth, [PIPELINES_CONFIG_SCOPE], `${base}/pipelines_config`, {
    method: 'PUT',
    json: { enabled },
  });
  if (!result.ok) return result;
  return { ok: true, enabled: result.body.enabled === true };
}

/** What a variable's key and value must look like; the message is for the page. */
export function validateVariableInput(
  input: unknown
): { ok: true; input: VariableInput } | { ok: false; message: string } {
  const body = rec(input);
  const key = str(body.key).trim();
  if (!VARIABLE_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      message:
        'A variable name is letters, digits and underscores, starting with a letter or underscore (at most 128 characters).',
    };
  }
  const value = typeof body.value === 'string' ? body.value : '';
  if (value.length > VARIABLE_VALUE_MAX_CHARS) {
    return { ok: false, message: 'The value is too long.' };
  }
  const environmentUuid = str(body.environmentUuid).trim();
  return {
    ok: true,
    input: {
      key,
      value,
      secured: body.secured === true,
      ...(environmentUuid ? { environmentUuid } : {}),
    },
  };
}

export async function createPipelineVariable(
  auth: BitbucketAuth,
  fullName: string,
  input: VariableInput
): Promise<{ ok: true; variable: PipelineVariable } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const created = await bbJson(
    auth,
    [PIPELINES_VARIABLE_SCOPE],
    variablesPath(base, input.environmentUuid),
    { method: 'POST', json: { key: input.key, value: input.value, secured: input.secured } }
  );
  if (!created.ok) return created;
  const variable = variableOf(created.body);
  return variable
    ? { ok: true, variable }
    : { ok: false, error: 'Bitbucket did not send the variable back.' };
}

/**
 * Replace one variable's key, value and secured flag. A secured
 * variable's value cannot be read, so the page sends a new one or none:
 * an empty value on a secured variable keeps what Bitbucket has, by
 * sending only the key and flag.
 */
export async function updatePipelineVariable(
  auth: BitbucketAuth,
  fullName: string,
  uuid: string,
  input: VariableInput
): Promise<{ ok: true; variable: PipelineVariable } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  if (!uuid.trim()) return { ok: false, error: 'Which variable?' };
  const keepValue = input.secured && input.value === '';
  const updated = await bbJson(
    auth,
    [PIPELINES_VARIABLE_SCOPE],
    `${variablesPath(base, input.environmentUuid)}/${uuidSegment(uuid)}`,
    {
      method: 'PUT',
      json: {
        key: input.key,
        secured: input.secured,
        ...(keepValue ? {} : { value: input.value }),
      },
    }
  );
  if (!updated.ok) return updated;
  const variable = variableOf(updated.body);
  return variable
    ? { ok: true, variable }
    : { ok: false, error: 'Bitbucket did not send the variable back.' };
}

export async function deletePipelineVariable(
  auth: BitbucketAuth,
  fullName: string,
  uuid: string,
  environmentUuid: string | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  if (!uuid.trim()) return { ok: false, error: 'Which variable?' };
  const response = await auth.fetch(
    [PIPELINES_VARIABLE_SCOPE],
    `${variablesPath(base, environmentUuid)}/${uuidSegment(uuid)}`,
    { method: 'DELETE' }
  );
  if (response.ok) return { ok: true };
  return { ok: false, error: await describeBitbucketFailure(response) };
}

// ——— The pipeline file itself: read, and committed from the page ———

/** The branch to work on: the project's, else the repository's main branch. */
async function branchOf(
  auth: BitbucketAuth,
  base: string,
  branch: string
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  if (branch) return { ok: true, ref: branch };
  const repo = await bbJson(auth, ['repository'], base);
  if (!repo.ok) return repo;
  const ref = str(rec(repo.body.mainbranch).name);
  return ref
    ? { ok: true, ref }
    : { ok: false, error: 'The repository has no branch yet; push something first.' };
}

/** The file's text on the branch, or null when there is none. */
export async function readPipelineConfigFile(
  auth: BitbucketAuth,
  fullName: string,
  branch: string
): Promise<{ ok: true; ref: string; text: string | null } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const found = await branchOf(auth, base, branch);
  if (!found.ok) return found;
  const file = await bbRawText(
    auth,
    ['repository'],
    `${base}/src/${encodeURIComponent(found.ref)}/${PIPELINES_CONFIG_FILE}`
  );
  if (file.ok) return { ok: true, ref: found.ref, text: file.text };
  if (/\b404\b/.test(file.error)) return { ok: true, ref: found.ref, text: null };
  return file;
}

/**
 * Commit the file to the branch — create or overwrite — the way the
 * chat's bitbucket_commit_file does: the src endpoint takes a form with
 * the file keyed by path, the message and the branch beside it.
 */
export async function commitPipelineConfigFile(
  auth: BitbucketAuth,
  fullName: string,
  branch: string,
  text: string,
  message: string
): Promise<{ ok: true; ref: string; url: string } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const found = await branchOf(auth, base, branch);
  if (!found.ok) return found;
  const form = new URLSearchParams();
  form.set(PIPELINES_CONFIG_FILE, text);
  form.set('message', message);
  form.set('branch', found.ref);
  const response = await auth.fetch([PIPELINES_FILE_SCOPE], `${base}/src`, {
    method: 'POST',
    form,
  });
  if (!response.ok) return { ok: false, error: await describeBitbucketFailure(response) };
  const [workspace, slug] = fullName.split('/');
  return {
    ok: true,
    ref: found.ref,
    url: `https://bitbucket.org/${encodeURIComponent(workspace ?? '')}/${encodeURIComponent(slug ?? '')}/src/${encodeURIComponent(found.ref)}/${PIPELINES_CONFIG_FILE}`,
  };
}

// ——— Variables as text: one box per set, parsed and applied as a diff ———

/**
 * A variable set as text, the way a `.env` reads: `KEY=value` a line
 * (`KEY: value` is taken too), `#` comments, quotes as dotenv has them,
 * and a `secret ` prefix on a line for a secured variable. A secured
 * variable's value cannot be read back, so it renders as `secret KEY=`
 * and an empty value on one that exists means "keep what Bitbucket has".
 */
export interface VariableEntry {
  key: string;
  value: string;
  secured: boolean;
}

export interface ParsedVariables {
  entries: VariableEntry[];
  /** Lines that were not variables, as "line N: why". */
  problems: string[];
}

const SECRET_PREFIX = /^(\s*)(?:secret|secured)\s+(?=[A-Za-z_])/i;
const YAML_LINE = /^(\s*[A-Za-z_][A-Za-z0-9_]*)\s*:(?:\s+|$)(.*)$/;

export function parseVariableText(text: string): ParsedVariables {
  const entries: VariableEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, index) => {
    const number = index + 1;
    if (!raw.trim() || raw.trim().startsWith('#')) return;
    let line = raw;
    const secured = SECRET_PREFIX.test(line);
    if (secured) line = line.replace(SECRET_PREFIX, '$1');
    const yaml = YAML_LINE.exec(line);
    if (yaml && !line.includes('=')) line = `${yaml[1]}=${yaml[2]}`;
    const parsed = parseDotenv(line);
    const key = Object.keys(parsed.values)[0];
    if (!key) {
      problems.push(
        ...parsed.problems.map((problem) => problem.replace(/^line 1:/, `line ${number}:`))
      );
      return;
    }
    if (!VARIABLE_KEY_PATTERN.test(key)) {
      problems.push(`line ${number}: ${key} is not a variable name`);
      return;
    }
    if (seen.has(key)) {
      problems.push(`line ${number}: ${key} is given twice; the last one wins`);
      entries.splice(
        entries.findIndex((entry) => entry.key === key),
        1
      );
    }
    seen.add(key);
    entries.push({ key, value: parsed.values[key] ?? '', secured });
  });
  return { entries, problems };
}

// Rendering the set as text is pure and lives beside the page's client
// code (pipeline-variables-text.ts): this module reaches the sandbox
// package for the parser, which a browser bundle cannot carry.
export { renderVariableText } from './pipeline-variables-text';

export interface VariablesApplied {
  added: string[];
  changed: string[];
  removed: string[];
  /** What Bitbucket refused, per key. */
  errors: string[];
}

/**
 * Make one set match the text: create what is new, replace what changed
 * (a secured variable with an empty value is kept as it is; a new secured
 * one needs a value), delete what is gone. Each change is its own call,
 * so a refusal is reported by key and the rest still applies.
 */
export async function applyVariableText(
  auth: BitbucketAuth,
  fullName: string,
  environmentUuid: string | undefined,
  current: readonly PipelineVariable[],
  entries: readonly VariableEntry[]
): Promise<VariablesApplied> {
  const applied: VariablesApplied = { added: [], changed: [], removed: [], errors: [] };
  const existing = new Map(current.map((variable) => [variable.key, variable]));
  const wanted = new Set(entries.map((entry) => entry.key));
  for (const entry of entries) {
    const input: VariableInput = { ...entry, environmentUuid };
    const before = existing.get(entry.key);
    if (!before) {
      if (entry.secured && entry.value === '') {
        applied.errors.push(`${entry.key}: a new secured variable needs a value.`);
        continue;
      }
      const created = await createPipelineVariable(auth, fullName, input);
      if (created.ok) applied.added.push(entry.key);
      else applied.errors.push(`${entry.key}: ${created.error}`);
      continue;
    }
    const keepSecured = before.secured && entry.secured && entry.value === '';
    const samePlain = !before.secured && !entry.secured && before.value === entry.value;
    if (keepSecured || samePlain) continue;
    const updated = await updatePipelineVariable(auth, fullName, before.uuid, input);
    if (updated.ok) applied.changed.push(entry.key);
    else applied.errors.push(`${entry.key}: ${updated.error}`);
  }
  for (const variable of current) {
    if (wanted.has(variable.key)) continue;
    const deleted = await deletePipelineVariable(auth, fullName, variable.uuid, environmentUuid);
    if (deleted.ok) applied.removed.push(variable.key);
    else applied.errors.push(`${variable.key}: ${deleted.error}`);
  }
  return applied;
}
