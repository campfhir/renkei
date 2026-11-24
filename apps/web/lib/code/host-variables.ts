/**
 * The variables a code project's pipelines run with, as its host keeps
 * them — Bitbucket Pipelines' or GitHub Actions' — read and changed for
 * the Variables tab of the project's Environments page. Two sets: the
 * repository's own, which every branch's runs get, and one deployment
 * environment's (the host's environment of the same name as the
 * project's), which only the jobs deploying it get.
 *
 * A change is a list: names to set, each with its value and whether it is
 * a secret, and names to remove. The page builds it — by hand, or from a
 * `.env` file it parses in the browser — and sends it here once, on Save;
 * no model sees it, and a value is never logged or sent back.
 *
 * What a secret is differs by host. Bitbucket keeps a variable with a
 * `secured` flag and never shows a secured value again. GitHub keeps
 * secrets apart from variables and takes one only sealed to the
 * repository's (or environment's) public key (sealed-box.ts); a name
 * moving between plain and secret is written in the one and removed from
 * the other. Either way a secret's value is write-only: it shows here by
 * name, and is replaced by typing a new one.
 */

import { isRecord } from '@renkei/guards';
import type { BitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import { bbJson } from '@/lib/mcp-tools/bitbucket/client';
import { describeGitHubFailure, ghJson, rec, str } from '@/lib/mcp-tools/github/client';
import type { GitHubAuth } from '@/lib/mcp-tools/github/github-auth';
import {
  PIPELINES_CONFIG_SCOPE,
  createPipelineVariable,
  deletePipelineVariable,
  listVariables,
  readEnvironments,
  repoBase,
  updatePipelineVariable,
  variablesPath,
  type PipelineVariable,
} from './bitbucket-pipelines';
import {
  ACTIONS_CONFIG_SCOPE,
  ACTIONS_READ_SCOPE,
  actionsSetPath,
  listActionsSecretNames,
  listActionsVariables,
  ownerRepoOf,
  validateActionsVariable,
} from './github-actions';
import { sealTo } from './sealed-box';

export type VariablesHost = 'bitbucket' | 'github';

/** One variable as the page lists it; a secret has no value to show. */
export interface HostVariable {
  key: string;
  value: string | null;
  secured: boolean;
}

export interface VariableSet {
  variables: HostVariable[];
  /** Why the set could not be read. */
  error: string | null;
}

/** What GET /api/code/projects/[id]/variables answers. */
export interface VariablesPage {
  host: VariablesHost;
  repository: VariableSet;
  /** The host's deployment environment of the name asked for; null when none was asked for. */
  environment: (VariableSet & { name: string; exists: boolean }) | null;
  /** Why this person cannot change variables from here; null when they can. */
  needs: string | null;
}

export interface VariableChange {
  key: string;
  value: string;
  secured: boolean;
}

export interface VariableChanges {
  set: VariableChange[];
  remove: string[];
}

export interface VariablesApplied {
  added: string[];
  changed: string[];
  removed: string[];
  /** What the host refused, per name. */
  errors: string[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VALUE_MAX_CHARS = 32_000;
export const MAX_CHANGES = 300;

/** A change as sent, read for shape; names and values are checked whole so nothing half-applies. */
export function readVariableChanges(
  body: unknown,
  /** A request that only makes the host's deployment environment changes no variable. */
  options: { allowEmpty?: boolean } = {}
): { ok: true; changes: VariableChanges } | { ok: false; message: string } {
  const sent = isRecord(body) ? body : {};
  const rawSet = Array.isArray(sent.set) ? sent.set : [];
  const rawRemove = Array.isArray(sent.remove) ? sent.remove : [];
  if (rawSet.length + rawRemove.length > MAX_CHANGES) {
    return { ok: false, message: `At most ${MAX_CHANGES} variables change in one save.` };
  }
  const set: VariableChange[] = [];
  const seen = new Set<string>();
  for (const raw of rawSet) {
    const key = isRecord(raw) && typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!isRecord(raw) || !KEY.test(key)) {
      return {
        ok: false,
        message: `${key || 'A variable'} is not a variable name: letters, digits and underscores, not starting with a digit.`,
      };
    }
    if (seen.has(key)) return { ok: false, message: `${key} is set twice.` };
    seen.add(key);
    const value = typeof raw.value === 'string' ? raw.value : '';
    if (value.length > VALUE_MAX_CHARS)
      return { ok: false, message: `${key}: the value is too long.` };
    set.push({ key, value, secured: raw.secured === true });
  }
  const remove: string[] = [];
  for (const raw of rawRemove) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY.test(key)) return { ok: false, message: 'A name to remove is not a variable name.' };
    if (seen.has(key)) return { ok: false, message: `${key} is both set and removed.` };
    if (!remove.includes(key)) remove.push(key);
  }
  if (set.length === 0 && remove.length === 0 && !options.allowEmpty) {
    return { ok: false, message: 'Nothing was changed.' };
  }
  return { ok: true, changes: { set, remove } };
}

const shown = (variables: readonly PipelineVariable[]): HostVariable[] =>
  variables
    .map((v) => ({ key: v.key, value: v.secured ? null : (v.value ?? ''), secured: v.secured }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ——— Bitbucket ———

async function bitbucketEnvironment(
  auth: BitbucketAuth,
  base: string,
  name: string
): Promise<
  { ok: true; uuid: string | null; variables: PipelineVariable[] } | { ok: false; error: string }
> {
  const read = await readEnvironments(auth, base);
  if (read.error) return { ok: false, error: read.error };
  const found = read.environments.find((e) => sameName(e.name, name));
  if (!found) return { ok: true, uuid: null, variables: [] };
  if (found.error) return { ok: false, error: found.error };
  return { ok: true, uuid: found.uuid, variables: found.variables };
}

export async function readBitbucketVariables(
  auth: BitbucketAuth,
  fullName: string,
  environment: string | null
): Promise<Pick<VariablesPage, 'repository' | 'environment'>> {
  const base = repoBase(fullName);
  if (!base) {
    const error = 'The repository name is not usable.';
    return { repository: { variables: [], error }, environment: null };
  }
  const [repository, deployment] = await Promise.all([
    listVariables(auth, variablesPath(base, undefined)),
    environment ? bitbucketEnvironment(auth, base, environment) : null,
  ]);
  return {
    repository: repository.ok
      ? { variables: shown(repository.variables), error: null }
      : { variables: [], error: repository.error },
    environment:
      environment && deployment
        ? deployment.ok
          ? {
              name: environment,
              exists: deployment.uuid !== null,
              variables: shown(deployment.variables),
              error: null,
            }
          : { name: environment, exists: false, variables: [], error: deployment.error }
        : null,
  };
}

/** Bitbucket's own kinds of environment: production's is Production, any other Test. */
async function createBitbucketEnvironment(
  auth: BitbucketAuth,
  base: string,
  name: string,
  production: boolean
): Promise<{ ok: true; uuid: string } | { ok: false; error: string }> {
  const made = await bbJson(auth, [PIPELINES_CONFIG_SCOPE], `${base}/environments`, {
    method: 'POST',
    json: {
      type: 'deployment_environment',
      name,
      environment_type: {
        type: 'deployment_environment_type',
        name: production ? 'Production' : 'Test',
      },
    },
  });
  if (!made.ok) return made;
  const uuid = str(made.body.uuid);
  return uuid
    ? { ok: true, uuid }
    : { ok: false, error: 'Bitbucket did not name the environment.' };
}

export async function applyBitbucketVariables(
  auth: BitbucketAuth,
  fullName: string,
  /** The deployment environment's name and whether it is the production one; null for the repository's set. */
  environment: { name: string; production: boolean } | null,
  changes: VariableChanges
): Promise<
  { ok: true; applied: VariablesApplied; created: boolean } | { ok: false; error: string }
> {
  const base = repoBase(fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  let environmentUuid: string | undefined;
  let current: PipelineVariable[];
  let created = false;
  if (environment) {
    const found = await bitbucketEnvironment(auth, base, environment.name);
    if (!found.ok) return found;
    if (found.uuid) {
      environmentUuid = found.uuid;
      current = found.variables;
    } else {
      const made = await createBitbucketEnvironment(
        auth,
        base,
        environment.name,
        environment.production
      );
      if (!made.ok) {
        return {
          ok: false,
          error: `Bitbucket has no deployment environment named ${environment.name}, and making it was refused: ${made.error}`,
        };
      }
      environmentUuid = made.uuid;
      current = [];
      created = true;
    }
  } else {
    const listed = await listVariables(auth, variablesPath(base, undefined));
    if (!listed.ok) return listed;
    current = listed.variables;
  }
  const applied: VariablesApplied = { added: [], changed: [], removed: [], errors: [] };
  const existing = new Map(current.map((variable) => [variable.key, variable]));
  for (const change of changes.set) {
    const input = { ...change, ...(environmentUuid ? { environmentUuid } : {}) };
    const before = existing.get(change.key);
    if (!before) {
      if (change.secured && change.value === '') {
        applied.errors.push(`${change.key}: a new secret needs a value.`);
        continue;
      }
      const made = await createPipelineVariable(auth, fullName, input);
      if (made.ok) applied.added.push(change.key);
      else applied.errors.push(`${change.key}: ${made.error}`);
      continue;
    }
    if (!before.secured && !change.secured && before.value === change.value) continue;
    if (before.secured && !change.secured && change.value === '') {
      applied.errors.push(
        `${change.key}: its value is secret and cannot be read back; type it again to make it plain.`
      );
      continue;
    }
    const updated = await updatePipelineVariable(auth, fullName, before.uuid, input);
    if (updated.ok) applied.changed.push(change.key);
    else applied.errors.push(`${change.key}: ${updated.error}`);
  }
  for (const key of changes.remove) {
    const before = existing.get(key);
    if (!before) continue;
    const deleted = await deletePipelineVariable(auth, fullName, before.uuid, environmentUuid);
    if (deleted.ok) applied.removed.push(key);
    else applied.errors.push(`${key}: ${deleted.error}`);
  }
  return { ok: true, applied, created };
}

// ——— GitHub ———

type Repo = { owner: string; repo: string };

function environmentPath(target: Repo, name: string): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/environments/${encodeURIComponent(name)}`;
}

async function githubEnvironmentExists(
  auth: GitHubAuth,
  target: Repo,
  name: string
): Promise<{ ok: true; exists: boolean } | { ok: false; error: string }> {
  // Whether it is there is read as the runs are; changing it is what stands on Configure Actions.
  const response = await auth.fetch([ACTIONS_READ_SCOPE], environmentPath(target, name));
  if (response.ok) return { ok: true, exists: true };
  if (response.status === 404) return { ok: true, exists: false };
  return { ok: false, error: await describeGitHubFailure(response) };
}

async function githubSets(
  auth: GitHubAuth,
  fullName: string,
  environment: string | undefined
): Promise<
  | { ok: true; variables: PipelineVariable[]; secrets: PipelineVariable[] }
  | { ok: false; error: string }
> {
  const [variables, secrets] = await Promise.all([
    listActionsVariables(auth, fullName, environment),
    listActionsSecretNames(auth, fullName, environment),
  ]);
  if (!variables.ok) return variables;
  if (!secrets.ok) return secrets;
  return { ok: true, variables: variables.variables, secrets: secrets.variables };
}

export async function readGithubVariables(
  auth: GitHubAuth,
  fullName: string,
  environment: string | null
): Promise<Pick<VariablesPage, 'repository' | 'environment'>> {
  const target = ownerRepoOf(fullName);
  if (!target) {
    const error = 'The repository name is not usable.';
    return { repository: { variables: [], error }, environment: null };
  }
  const set = (read: Awaited<ReturnType<typeof githubSets>>): VariableSet =>
    read.ok
      ? { variables: shown([...read.variables, ...read.secrets]), error: null }
      : { variables: [], error: read.error };
  const exists = environment ? await githubEnvironmentExists(auth, target, environment) : null;
  const [repository, deployment] = await Promise.all([
    githubSets(auth, fullName, undefined),
    environment && exists?.ok && exists.exists ? githubSets(auth, fullName, environment) : null,
  ]);
  return {
    repository: set(repository),
    environment:
      environment && exists
        ? !exists.ok
          ? { name: environment, exists: false, variables: [], error: exists.error }
          : deployment
            ? { name: environment, exists: true, ...set(deployment) }
            : { name: environment, exists: false, variables: [], error: null }
        : null,
  };
}

/** The key GitHub seals this set's secrets to. */
async function sealingKey(
  auth: GitHubAuth,
  secretsPath: string
): Promise<{ ok: true; keyId: string; key: string } | { ok: false; error: string }> {
  const read = await ghJson(auth, [ACTIONS_CONFIG_SCOPE], `${secretsPath}/public-key`);
  if (!read.ok) return read;
  const body = rec(read.body);
  const keyId = str(body.key_id);
  const key = str(body.key);
  return keyId && key
    ? { ok: true, keyId, key }
    : { ok: false, error: 'GitHub did not send the key secrets are sealed to.' };
}

export async function applyGithubVariables(
  auth: GitHubAuth,
  fullName: string,
  environment: { name: string; production: boolean } | null,
  changes: VariableChanges
): Promise<
  { ok: true; applied: VariablesApplied; created: boolean } | { ok: false; error: string }
> {
  const target = ownerRepoOf(fullName);
  if (!target) return { ok: false, error: 'The repository name is not usable.' };
  let created = false;
  if (environment) {
    const exists = await githubEnvironmentExists(auth, target, environment.name);
    if (!exists.ok) return exists;
    if (!exists.exists) {
      const made = await auth.fetch(
        [ACTIONS_CONFIG_SCOPE],
        environmentPath(target, environment.name),
        {
          method: 'PUT',
        }
      );
      if (!made.ok) {
        return {
          ok: false,
          error: `GitHub has no environment named ${environment.name}, and making it was refused: ${await describeGitHubFailure(made)}`,
        };
      }
      created = true;
    }
  }
  const scope = environment?.name;
  const current = await githubSets(auth, fullName, scope);
  if (!current.ok) return current;
  const variablesBase = actionsSetPath(target, 'variables', scope);
  const secretsBase = actionsSetPath(target, 'secrets', scope);
  const variables = new Map(current.variables.map((v) => [v.key, v]));
  const secrets = new Set(current.secrets.map((v) => v.key));
  const applied: VariablesApplied = { added: [], changed: [], removed: [], errors: [] };
  const drop = async (base: string, key: string): Promise<string | null> => {
    const response = await auth.fetch(
      [ACTIONS_CONFIG_SCOPE],
      `${base}/${encodeURIComponent(key)}`,
      {
        method: 'DELETE',
      }
    );
    return response.ok || response.status === 404 ? null : await describeGitHubFailure(response);
  };
  let key: Awaited<ReturnType<typeof sealingKey>> | null = null;

  for (const change of changes.set) {
    const valid = validateActionsVariable(change.key, change.value);
    if (!valid.ok) {
      applied.errors.push(valid.message);
      continue;
    }
    const existed = variables.has(change.key) || secrets.has(change.key);
    if (change.secured) {
      if (change.value === '') {
        applied.errors.push(`${change.key}: a secret needs a value.`);
        continue;
      }
      key ??= await sealingKey(auth, secretsBase);
      if (!key.ok) {
        applied.errors.push(`${change.key}: ${key.error}`);
        continue;
      }
      const sealed = sealTo(key.key, change.value);
      if (!sealed) {
        applied.errors.push(`${change.key}: GitHub’s key for sealing secrets is not usable.`);
        continue;
      }
      const put = await auth.fetch(
        [ACTIONS_CONFIG_SCOPE],
        `${secretsBase}/${encodeURIComponent(change.key)}`,
        { method: 'PUT', json: { encrypted_value: sealed, key_id: key.keyId }, withholdBody: true }
      );
      if (!put.ok) {
        applied.errors.push(`${change.key}: ${await describeGitHubFailure(put)}`);
        continue;
      }
      // It was a plain variable: the secret replaces it.
      const stale = variables.has(change.key) ? await drop(variablesBase, change.key) : null;
      if (stale)
        applied.errors.push(
          `${change.key}: saved as a secret, but its plain variable stayed: ${stale}`
        );
      (existed ? applied.changed : applied.added).push(change.key);
      continue;
    }
    const before = variables.get(change.key);
    if (before && before.value === change.value && !secrets.has(change.key)) continue;
    if (!before && secrets.has(change.key) && change.value === '') {
      applied.errors.push(
        `${change.key}: its value is secret and cannot be read back; type it again to make it plain.`
      );
      continue;
    }
    const written = before
      ? await ghJson(
          auth,
          [ACTIONS_CONFIG_SCOPE],
          `${variablesBase}/${encodeURIComponent(change.key)}`,
          {
            method: 'PATCH',
            json: { name: change.key, value: change.value },
            withholdBody: true,
          }
        )
      : await ghJson(auth, [ACTIONS_CONFIG_SCOPE], variablesBase, {
          method: 'POST',
          json: { name: change.key, value: change.value },
          withholdBody: true,
        });
    if (!written.ok) {
      applied.errors.push(`${change.key}: ${written.error}`);
      continue;
    }
    const stale = secrets.has(change.key) ? await drop(secretsBase, change.key) : null;
    if (stale)
      applied.errors.push(`${change.key}: saved as plain, but its secret stayed: ${stale}`);
    (existed ? applied.changed : applied.added).push(change.key);
  }
  for (const name of changes.remove) {
    const failures = [
      variables.has(name) ? await drop(variablesBase, name) : null,
      secrets.has(name) ? await drop(secretsBase, name) : null,
    ].filter((failure): failure is string => failure !== null);
    if (failures.length > 0) applied.errors.push(`${name}: ${failures.join(' ')}`);
    else if (variables.has(name) || secrets.has(name)) applied.removed.push(name);
  }
  return { ok: true, applied, created };
}
