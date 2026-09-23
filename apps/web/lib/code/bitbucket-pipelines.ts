/**
 * A code project's Bitbucket Pipelines setup, for the project page:
 * whether Pipelines is switched on for the repository, whether a
 * `bitbucket-pipelines.yml` sits on the project's branch, and the
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

import type { BitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import {
  bbJson,
  bbRawText,
  describeBitbucketFailure,
  rec,
  str,
  values,
} from '@/lib/mcp-tools/bitbucket/client';

/** The Bitbucket scopes each half of the page stands on (docs/bitbucket-cloud-rest-api-open-api-spec.json). */
export const PIPELINES_CONFIG_SCOPE = 'repository:admin';
export const PIPELINES_VARIABLE_SCOPE = 'pipeline:variable';
export const PIPELINES_READ_SCOPE = 'pipeline';

export const PIPELINES_CONFIG_FILE = 'bitbucket-pipelines.yml';

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

export interface PipelineSetup {
  /** Null when the switch could not be read (the grant lacks repository:admin, or Bitbucket refused). */
  enabled: boolean | null;
  enabledError: string | null;
  /** Whether the YAML is on the project's branch; unknown when the branch could not be read. */
  configFile: 'present' | 'absent' | 'unknown';
  variables: PipelineVariable[];
  variablesError: string | null;
  environments: DeploymentEnvironment[];
  environmentsError: string | null;
}

export interface VariableInput {
  key: string;
  value: string;
  secured: boolean;
  /** Set for a deployment environment's variable; absent for the repository's. */
  environmentUuid?: string;
}

function repoBase(fullName: string): string | null {
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
function variablesPath(base: string, environmentUuid: string | undefined): string {
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
async function listVariables(
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
  options: { readSwitch: boolean }
): Promise<{ ok: true; setup: PipelineSetup } | { ok: false; error: string }> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const [switchState, configFile, variables, environments] = await Promise.all([
    options.readSwitch ? readEnabled(auth, base) : { enabled: null, error: null },
    readConfigFile(auth, base, branch),
    listVariables(auth, variablesPath(base, undefined)),
    readEnvironments(auth, base),
  ]);
  return {
    ok: true,
    setup: {
      enabled: switchState.enabled,
      enabledError: switchState.error,
      configFile,
      variables: variables.ok ? variables.variables : [],
      variablesError: variables.ok ? null : variables.error,
      environments: environments.environments,
      environmentsError: environments.error,
    },
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
