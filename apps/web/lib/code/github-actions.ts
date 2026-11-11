/**
 * A GitHub code project's Actions setup, for its Actions page, the
 * project page's card and the chat's pipeline-variable tools — the
 * counterpart of lib/code/bitbucket-pipelines.ts, read and written with
 * the signed-in person's own GitHub grant: whether Actions is switched on
 * for the repository, the workflow files on the project's branch (GitHub
 * has many, under `.github/workflows/`, where Bitbucket has one), the
 * recent runs, and the variables runs get — the repository's own and
 * each deployment environment's.
 *
 * What is the same as Bitbucket's page is the same code: a variable set
 * is one `KEY=value` text box applied as a difference (parseVariableText),
 * and a variable here is the PipelineVariable the page already draws —
 * its `uuid` is its name, since GitHub names variables rather than
 * numbering them. An environment's `uuid` is its name for the same reason.
 *
 * What differs is secrets. GitHub never sends a secret's value back (as
 * Bitbucket never sends a secured variable's), but it also takes one only
 * sealed to a repository public key with libsodium's sealed box, which
 * nothing here carries. So secrets are listed by name, read-only, shown as
 * secured, and set on github.com; every other half of the page works.
 */

import {
  arr,
  describeGitHubFailure,
  ghJson,
  rec,
  repoUrl,
  str,
} from '@/lib/mcp-tools/github/client';
import type { GitHubAuth } from '@/lib/mcp-tools/github/github-auth';
import {
  parseVariableText,
  type PipelineVariable,
  type VariableEntry,
  type VariablesApplied,
} from './bitbucket-pipelines';
import type { HostPipelineRun } from './repo-host';
import { WORKFLOWS_DIRECTORY, workflowFileName } from './workflow-file-name';

export { WORKFLOWS_DIRECTORY, workflowFileName };
import { githubHostAdapter } from './repo-host-github';

/** The capabilities each half of the page stands on (lib/github-scopes.ts). */
export const ACTIONS_READ_SCOPE = 'actions';
/** Reading and writing variables, secret names and the switch. */
export const ACTIONS_CONFIG_SCOPE = 'actions:configure';
/** Committing a workflow file: what a code project's pushes already stand on. */
export const ACTIONS_FILE_SCOPE = 'repository:write';
export const ACTIONS_CONTENTS_SCOPE = 'repository';

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const VARIABLE_VALUE_MAX_CHARS = 48_000;
/** A page of variables or secrets is at most 30 on GitHub's side. */
const PAGE = 30;
const MAX_PAGES = 10;

export interface ActionsEnvironment {
  /** The environment's name — what GitHub's paths take. */
  uuid: string;
  name: string;
  /** Always empty: GitHub has no environment categories. */
  type: string;
  variables: PipelineVariable[];
  /** Secret names, shown as secured: their values are never readable. */
  secrets: PipelineVariable[];
  error: string | null;
}

export interface WorkflowFile {
  /** The file's name under .github/workflows, like `ci.yml`. */
  name: string;
  path: string;
}

export interface ActionsSetup {
  /** Null when the switch could not be read. */
  enabled: boolean | null;
  enabledError: string | null;
  /** The workflow files on the project's branch; null when the branch could not be read. */
  workflows: WorkflowFile[] | null;
  workflowsError: string | null;
  runs: HostPipelineRun[];
  runsError: string | null;
  variables: PipelineVariable[];
  variablesError: string | null;
  /** The repository's secret names, shown as secured. */
  secrets: PipelineVariable[];
  secretsError: string | null;
  environments: ActionsEnvironment[];
  environmentsError: string | null;
}

/** What the project page's card shows: the setup at a glance, and the last run. */
export interface ActionsSummary {
  enabled: boolean | null;
  enabledError: string | null;
  workflowCount: number | null;
  variableCount: number | null;
  environmentCount: number;
  lastRun: HostPipelineRun | null;
  runsError: string | null;
}

export function ownerRepoOf(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

function repoPath(target: { owner: string; repo: string }): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

/** Where variables (or secrets) live: the repository's set, or one environment's. */
export function actionsSetPath(
  target: { owner: string; repo: string },
  kind: 'variables' | 'secrets',
  environment: string | undefined
): string {
  return environment
    ? `${repoPath(target)}/environments/${encodeURIComponent(environment)}/${kind}`
    : `${repoPath(target)}/actions/${kind}`;
}

/** Every page of a variables or secrets listing, as the page's own variable shape. */
async function listSet(
  auth: GitHubAuth,
  path: string,
  kind: 'variables' | 'secrets'
): Promise<{ ok: true; variables: PipelineVariable[] } | { ok: false; error: string }> {
  const variables: PipelineVariable[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const listed = await ghJson(
      auth,
      [ACTIONS_CONFIG_SCOPE],
      `${path}?per_page=${PAGE}&page=${page}`
    );
    if (!listed.ok) return listed;
    for (const raw of arr(rec(listed.body)[kind])) {
      const name = str(raw.name);
      if (!name) continue;
      variables.push(
        kind === 'variables'
          ? { uuid: name, key: name, value: str(raw.value), secured: false }
          : { uuid: name, key: name, value: null, secured: true }
      );
    }
    if (!listed.hasMore) break;
  }
  variables.sort((a, b) => a.key.localeCompare(b.key));
  return { ok: true, variables };
}

export function listActionsVariables(
  auth: GitHubAuth,
  fullName: string,
  environment: string | undefined
): Promise<{ ok: true; variables: PipelineVariable[] } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  if (!target) return Promise.resolve({ ok: false, error: 'The repository name is not usable.' });
  return listSet(auth, actionsSetPath(target, 'variables', environment), 'variables');
}

export function listActionsSecretNames(
  auth: GitHubAuth,
  fullName: string,
  environment: string | undefined
): Promise<{ ok: true; variables: PipelineVariable[] } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  if (!target) return Promise.resolve({ ok: false, error: 'The repository name is not usable.' });
  return listSet(auth, actionsSetPath(target, 'secrets', environment), 'secrets');
}

/** The deployment environments' names, with their variables and secret names. */
async function readEnvironments(
  auth: GitHubAuth,
  target: { owner: string; repo: string }
): Promise<{ environments: ActionsEnvironment[]; error: string | null }> {
  const listed = await ghJson(
    auth,
    [ACTIONS_READ_SCOPE],
    `${repoPath(target)}/environments?per_page=100`
  );
  if (!listed.ok) return { environments: [], error: listed.error };
  const names = arr(rec(listed.body).environments)
    .map((raw) => str(raw.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const environments = await Promise.all(
    names.map(async (name): Promise<ActionsEnvironment> => {
      const [variables, secrets] = await Promise.all([
        listSet(auth, actionsSetPath(target, 'variables', name), 'variables'),
        listSet(auth, actionsSetPath(target, 'secrets', name), 'secrets'),
      ]);
      return {
        uuid: name,
        name,
        type: '',
        variables: variables.ok ? variables.variables : [],
        secrets: secrets.ok ? secrets.variables : [],
        error: variables.ok ? null : variables.error,
      };
    })
  );
  return { environments, error: null };
}

/** The workflow files on the branch — the repository's default branch when the project names none. */
export async function listWorkflowFiles(
  auth: GitHubAuth,
  fullName: string,
  branch: string
): Promise<{ ok: true; workflows: WorkflowFile[] } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  if (!target) return { ok: false, error: 'The repository name is not usable.' };
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const listed = await ghJson(
    auth,
    [ACTIONS_CONTENTS_SCOPE],
    `${repoPath(target)}/contents/${WORKFLOWS_DIRECTORY}${ref}`
  );
  if (!listed.ok) {
    // No workflows directory is an empty list, not a failure.
    return /\bnot found\b|\b404\b/i.test(listed.error) ? { ok: true, workflows: [] } : listed;
  }
  const workflows = arr(listed.body)
    .filter((entry) => str(entry.type) === 'file' && /\.ya?ml$/i.test(str(entry.name)))
    .map((entry) => ({ name: str(entry.name), path: str(entry.path) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, workflows };
}

/**
 * The whole setup, in one read. The switch is read only when asked: its
 * endpoint stands on a capability a connection may have been narrowed
 * away from, and the page says so in its own words rather than GitHub's.
 */
export async function readActionsSetup(
  auth: GitHubAuth,
  fullName: string,
  branch: string,
  options: { readConfig: boolean; runs?: number }
): Promise<{ ok: true; setup: ActionsSetup } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  if (!target) return { ok: false, error: 'The repository name is not usable.' };
  const adapter = githubHostAdapter({ subject: '', origin: '' }, auth);
  const nothing: { ok: true; variables: PipelineVariable[] } = { ok: true, variables: [] };
  const [enabled, workflows, runs, variables, secrets, environments] = await Promise.all([
    options.readConfig ? readEnabled(auth, target) : { enabled: null, error: null },
    listWorkflowFiles(auth, fullName, branch),
    adapter.listPipelineRuns(fullName, {
      max: options.runs ?? 20,
      ...(branch ? { branch } : {}),
    }),
    options.readConfig ? listActionsVariables(auth, fullName, undefined) : nothing,
    options.readConfig ? listActionsSecretNames(auth, fullName, undefined) : nothing,
    options.readConfig ? readEnvironments(auth, target) : { environments: [], error: null },
  ]);
  return {
    ok: true,
    setup: {
      enabled: enabled.enabled,
      enabledError: enabled.error,
      workflows: workflows.ok ? workflows.workflows : null,
      workflowsError: workflows.ok ? null : workflows.error,
      runs: runs.ok ? runs.runs : [],
      runsError: runs.ok ? null : runs.error,
      variables: variables.ok ? variables.variables : [],
      variablesError: variables.ok ? null : variables.error,
      secrets: secrets.ok ? secrets.variables : [],
      secretsError: secrets.ok ? null : secrets.error,
      environments: environments.environments,
      environmentsError: environments.error,
    },
  };
}

export function summarizeActions(setup: ActionsSetup, configured: boolean): ActionsSummary {
  return {
    enabled: setup.enabled,
    enabledError: setup.enabledError,
    workflowCount: setup.workflows ? setup.workflows.length : null,
    variableCount:
      configured && !setup.variablesError
        ? setup.variables.length +
          setup.environments.reduce((sum, environment) => sum + environment.variables.length, 0)
        : null,
    environmentCount: setup.environments.length,
    lastRun: setup.runs[0] ?? null,
    runsError: setup.runsError,
  };
}

async function readEnabled(
  auth: GitHubAuth,
  target: { owner: string; repo: string }
): Promise<{ enabled: boolean | null; error: string | null }> {
  const permissions = await ghJson(
    auth,
    [ACTIONS_CONFIG_SCOPE],
    `${repoPath(target)}/actions/permissions`
  );
  if (!permissions.ok) return { enabled: null, error: permissions.error };
  return { enabled: rec(permissions.body).enabled === true, error: null };
}

/** The switch: whether GitHub runs Actions for this repository at all. */
export async function setActionsEnabled(
  auth: GitHubAuth,
  fullName: string,
  enabled: boolean
): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  if (!target) return { ok: false, error: 'The repository name is not usable.' };
  const response = await auth.fetch(
    [ACTIONS_CONFIG_SCOPE],
    `${repoPath(target)}/actions/permissions`,
    {
      method: 'PUT',
      json: { enabled },
    }
  );
  if (!response.ok) return { ok: false, error: await describeGitHubFailure(response) };
  return { ok: true, enabled };
}

/** What a variable's name and value must look like; the message is for the page and the chat. */
export function validateActionsVariable(
  key: string,
  value: string
): { ok: true } | { ok: false; message: string } {
  if (!VARIABLE_NAME_PATTERN.test(key) || /^GITHUB_/i.test(key)) {
    return {
      ok: false,
      message: `${key || 'A variable name'} is not allowed: letters, digits and underscores, not starting with a digit or GITHUB_.`,
    };
  }
  if (value.length > VARIABLE_VALUE_MAX_CHARS)
    return { ok: false, message: `${key}: the value is too long.` };
  return { ok: true };
}

/**
 * Make one set match the text: create what is new, replace what changed,
 * delete what is gone — each its own call, so a refusal is reported by key
 * and the rest still applies. A `secret` line cannot be written here (see
 * the module note) and is reported instead of being stored as plain text.
 * With `prune: false` nothing is deleted: the chat's writes add and change
 * only what they name.
 */
export async function applyActionsVariables(
  auth: GitHubAuth,
  fullName: string,
  environment: string | undefined,
  current: readonly PipelineVariable[],
  entries: readonly VariableEntry[],
  options: { prune: boolean } = { prune: true }
): Promise<VariablesApplied> {
  const applied: VariablesApplied = { added: [], changed: [], removed: [], errors: [] };
  const target = ownerRepoOf(fullName);
  if (!target) {
    applied.errors.push('The repository name is not usable.');
    return applied;
  }
  const base = actionsSetPath(target, 'variables', environment);
  const existing = new Map(current.map((variable) => [variable.key, variable]));
  const wanted = new Set(entries.map((entry) => entry.key));
  for (const entry of entries) {
    if (entry.secured) {
      applied.errors.push(
        `${entry.key}: a secret cannot be set from here — add it under Settings → Secrets on GitHub.`
      );
      continue;
    }
    const valid = validateActionsVariable(entry.key, entry.value);
    if (!valid.ok) {
      applied.errors.push(valid.message);
      continue;
    }
    const before = existing.get(entry.key);
    if (before && before.value === entry.value) continue;
    const result = before
      ? await ghJson(auth, [ACTIONS_CONFIG_SCOPE], `${base}/${encodeURIComponent(entry.key)}`, {
          method: 'PATCH',
          json: { name: entry.key, value: entry.value },
        })
      : await ghJson(auth, [ACTIONS_CONFIG_SCOPE], base, {
          method: 'POST',
          json: { name: entry.key, value: entry.value },
        });
    if (!result.ok) applied.errors.push(`${entry.key}: ${result.error}`);
    else (before ? applied.changed : applied.added).push(entry.key);
  }
  if (!options.prune) return applied;
  for (const variable of current) {
    if (wanted.has(variable.key)) continue;
    const deleted = await auth.fetch(
      [ACTIONS_CONFIG_SCOPE],
      `${base}/${encodeURIComponent(variable.key)}`,
      { method: 'DELETE' }
    );
    if (deleted.ok) applied.removed.push(variable.key);
    else applied.errors.push(`${variable.key}: ${await describeGitHubFailure(deleted)}`);
  }
  return applied;
}

export async function deleteActionsVariable(
  auth: GitHubAuth,
  fullName: string,
  environment: string | undefined,
  key: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  if (!target) return { ok: false, error: 'The repository name is not usable.' };
  const response = await auth.fetch(
    [ACTIONS_CONFIG_SCOPE],
    `${actionsSetPath(target, 'variables', environment)}/${encodeURIComponent(key)}`,
    { method: 'DELETE' }
  );
  return response.ok ? { ok: true } : { ok: false, error: await describeGitHubFailure(response) };
}

/** The page's Save: parse the text, read the set, apply the difference. */
export async function applyActionsVariableText(
  auth: GitHubAuth,
  fullName: string,
  environment: string | undefined,
  text: string
): Promise<
  { ok: true; applied: VariablesApplied; problems: string[] } | { ok: false; error: string }
> {
  const parsed = parseVariableText(text);
  const current = await listActionsVariables(auth, fullName, environment);
  if (!current.ok) return current;
  const applied = await applyActionsVariables(
    auth,
    fullName,
    environment,
    current.variables,
    parsed.entries
  );
  return { ok: true, applied, problems: parsed.problems };
}

// ——— Workflow files ———

function contentsPath(target: { owner: string; repo: string }, name: string): string {
  return `${repoPath(target)}/contents/${WORKFLOWS_DIRECTORY}/${encodeURIComponent(name)}`;
}

/** One workflow file's text on the branch, or null when there is none. */
export async function readWorkflowFile(
  auth: GitHubAuth,
  fullName: string,
  branch: string,
  name: string
): Promise<{ ok: true; ref: string; text: string | null } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  const file = workflowFileName(name);
  if (!target || !file) return { ok: false, error: 'The workflow file name is not usable.' };
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const found = await ghJson(auth, [ACTIONS_CONTENTS_SCOPE], `${contentsPath(target, file)}${ref}`);
  if (!found.ok) {
    return /\bnot found\b|\b404\b/i.test(found.error)
      ? { ok: true, ref: branch, text: null }
      : found;
  }
  const encoded = str(rec(found.body).content).replace(/\s+/g, '');
  return { ok: true, ref: branch, text: Buffer.from(encoded, 'base64').toString('utf8') };
}

/** Commit one workflow file to the branch — create or overwrite. */
export async function commitWorkflowFile(
  auth: GitHubAuth,
  fullName: string,
  branch: string,
  name: string,
  text: string,
  message: string
): Promise<{ ok: true; ref: string; url: string } | { ok: false; error: string }> {
  const target = ownerRepoOf(fullName);
  const file = workflowFileName(name);
  if (!target || !file) return { ok: false, error: 'The workflow file name is not usable.' };
  const path = contentsPath(target, file);
  const query = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  // An overwrite needs the existing blob's sha; a 404 just means a new file.
  const existing = await ghJson(auth, [ACTIONS_CONTENTS_SCOPE], `${path}${query}`);
  const sha = existing.ok ? str(rec(existing.body).sha) : '';
  const committed = await ghJson(auth, [ACTIONS_FILE_SCOPE], path, {
    method: 'PUT',
    json: {
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      ...(branch ? { branch } : {}),
      ...(sha ? { sha } : {}),
    },
  });
  if (!committed.ok) return committed;
  const ref = branch || str(rec(rec(committed.body).commit).sha).slice(0, 12);
  return {
    ok: true,
    ref: branch || 'the default branch',
    url: branch
      ? `${repoUrl(target.owner, target.repo)}/blob/${encodeURIComponent(branch)}/${WORKFLOWS_DIRECTORY}/${file}`
      : `${repoUrl(target.owner, target.repo)}/blob/${ref}/${WORKFLOWS_DIRECTORY}/${file}`,
  };
}
