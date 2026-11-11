/**
 * The code_pipeline_* tools: how a chat in a code project reads and sets
 * the variables its pipelines get — the repository's and each deployment
 * environment's — so a pipeline it drafts (a `bitbucket-pipelines.yml`, a
 * GitHub Actions workflow) arrives with the variables it needs. Local
 * tools bound to ONE project's repository, like the rest of the code_*
 * set (tools.ts); they ask the chatting person's own grant on the
 * project's host, never anything wider.
 *
 * What a chat gets is the plain half. A secured variable (a Bitbucket
 * secured variable; a GitHub secret, which is listed by name only) comes
 * back by name with its value omitted, as the Pipelines page shows it,
 * and a chat can neither replace nor remove one, nor write a value for a
 * name that reads as a secret (pipeline-variable-plan.ts decides all of
 * that). The person adds those on the Pipelines page. A write only adds,
 * changes and removes the names it gives — it never prunes a set the way
 * the page's Save does — and the audit log records the keys, never a
 * value.
 */

import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import { grantScopes, missingScope, type PipelinesHost } from './access';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  PIPELINES_READ_SCOPE,
  PIPELINES_VARIABLE_SCOPE,
  applyVariableText,
  deletePipelineVariable,
  listVariables,
  readEnvironments,
  repoBase,
  validateVariableInput,
  variablesPath,
  type PipelineVariable,
} from './bitbucket-pipelines';
import { bitbucketAuthOf } from './bitbucket-browse';
import {
  ACTIONS_CONFIG_SCOPE,
  applyActionsVariables,
  deleteActionsVariable,
  listActionsSecretNames,
  listActionsVariables,
  ownerRepoOf,
  validateActionsVariable,
} from './github-actions';
import { githubAuthOf } from './github-browse';
import {
  planVariableWrite,
  renderVariableSet,
  renderWriteOutcome,
  type VariableWritePlan,
} from './pipeline-variable-plan';
import { arr, ghJson, rec, str } from '@/lib/mcp-tools/github/client';
import type { VariablesApplied } from './bitbucket-pipelines';

export interface PipelineToolDeps {
  /** ATLASSIAN_BITBUCKET or GITHUB — the project's host. */
  repoProvider: string;
  repoFullName: string;
  /** The deployment's origin, for the host's app reader. */
  origin: string;
}

const NAME_MAX = 255;

const environmentProperty = {
  type: 'string',
  maxLength: NAME_MAX,
  description:
    'A deployment environment’s name (as code_pipeline_variables lists them). Omit for the repository’s own variables.',
};

function hostOf(provider: string): PipelinesHost | null {
  return provider === GITHUB
    ? GITHUB
    : provider === ATLASSIAN_BITBUCKET
      ? ATLASSIAN_BITBUCKET
      : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `{ KEY: "value" }` from a tool input; anything that is not a name to a string is dropped. */
function variablesOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(rec(value))) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

interface EnvironmentSet {
  name: string;
  variables: PipelineVariable[];
  /** GitHub secret names; Bitbucket's secured ones are among `variables`. */
  secrets: PipelineVariable[];
  error: string | null;
}

interface PipelineSets {
  repository: PipelineVariable[];
  repositorySecrets: PipelineVariable[];
  environments: EnvironmentSet[];
}

/** The host's variable sets, read through the person's grant. */
async function readSets(
  deps: PipelineToolDeps,
  subject: string
): Promise<{ ok: true; sets: PipelineSets } | { ok: false; error: string }> {
  if (deps.repoProvider === GITHUB) {
    const auth = githubAuthOf({ subject, origin: deps.origin });
    const target = ownerRepoOf(deps.repoFullName);
    if (!target) return { ok: false, error: 'The repository name is not usable.' };
    const [variables, secrets, environments] = await Promise.all([
      listActionsVariables(auth, deps.repoFullName, undefined),
      listActionsSecretNames(auth, deps.repoFullName, undefined),
      ghJson(
        auth,
        ['actions'],
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/environments?per_page=100`
      ),
    ]);
    if (!variables.ok) return variables;
    const names = environments.ok
      ? arr(rec(environments.body).environments)
          .map((raw) => str(raw.name))
          .filter(Boolean)
      : [];
    const sets = await Promise.all(
      names.map(async (name): Promise<EnvironmentSet> => {
        const [envVariables, envSecrets] = await Promise.all([
          listActionsVariables(auth, deps.repoFullName, name),
          listActionsSecretNames(auth, deps.repoFullName, name),
        ]);
        return {
          name,
          variables: envVariables.ok ? envVariables.variables : [],
          secrets: envSecrets.ok ? envSecrets.variables : [],
          error: envVariables.ok ? null : envVariables.error,
        };
      })
    );
    return {
      ok: true,
      sets: {
        repository: variables.variables,
        repositorySecrets: secrets.ok ? secrets.variables : [],
        environments: sets,
      },
    };
  }
  const base = repoBase(deps.repoFullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const auth = bitbucketAuthOf({ subject, origin: deps.origin });
  const [variables, environments] = await Promise.all([
    listVariables(auth, variablesPath(base, undefined)),
    readEnvironments(auth, base),
  ]);
  if (!variables.ok) return variables;
  return {
    ok: true,
    sets: {
      repository: variables.variables,
      repositorySecrets: [],
      environments: environments.environments.map((environment) => ({
        name: environment.name,
        variables: environment.variables,
        secrets: [],
        error: environment.error,
      })),
    },
  };
}

function renderSet(
  title: string,
  variables: PipelineVariable[],
  secrets: PipelineVariable[]
): string {
  return renderVariableSet(title, [...variables, ...secrets]);
}

export function renderSets(sets: PipelineSets, only: string | null): string {
  const parts: string[] = [];
  if (only === null) {
    parts.push(renderSet('Repository variables', sets.repository, sets.repositorySecrets));
  }
  for (const environment of sets.environments) {
    if (only !== null && environment.name !== only) continue;
    parts.push(
      environment.error
        ? `Environment “${environment.name}”: could not be read — ${environment.error}`
        : renderSet(
            `Environment “${environment.name}” variables`,
            environment.variables,
            environment.secrets
          )
    );
  }
  if (only !== null && parts.length === 0) {
    const known = sets.environments.map((environment) => `“${environment.name}”`).join(', ');
    return `No deployment environment is named “${only}”. ${known ? `Environments: ${known}.` : 'This repository has none.'}`;
  }
  return parts.join('\n\n');
}

export function pipelineVariableTools(deps: PipelineToolDeps): LocalTool[] {
  const host = hostOf(deps.repoProvider);
  if (!host) return [];
  const hostName = host === GITHUB ? 'GitHub Actions' : 'Bitbucket Pipelines';
  const readScope = host === GITHUB ? ACTIONS_CONFIG_SCOPE : PIPELINES_READ_SCOPE;
  const writeScope = host === GITHUB ? ACTIONS_CONFIG_SCOPE : PIPELINES_VARIABLE_SCOPE;
  const secretsNote =
    host === GITHUB
      ? 'Secrets are listed by name with their values omitted (GitHub never returns one).'
      : 'Secured variables come back by name with their values omitted (Bitbucket never returns one).';

  return [
    {
      def: {
        name: 'code_pipeline_variables',
        description:
          `The variables this project’s ${hostName} runs get — the repository’s and each ` +
          `deployment environment’s — so a pipeline you write uses names that exist and a missing ` +
          `one can be added. ${secretsNote} Use it before drafting a pipeline, and again after ` +
          'code_pipeline_set_variables. Pass environment to read just one.',
        inputSchema: { type: 'object', properties: { environment: environmentProperty } },
      },
      readOnly: true,
      async execute(input, context) {
        const needs = missingScope(await grantScopes(context.subject, host), readScope, host);
        if (needs) return errorResult(needs);
        const read = await readSets(deps, context.subject);
        if (!read.ok) return errorResult(read.error);
        return textResult(renderSets(read.sets, asText(input.environment).trim() || null));
      },
    },
    {
      def: {
        name: 'code_pipeline_set_variables',
        description:
          `Add, change or remove plain variables for this project’s ${hostName} — a base URL, a ` +
          'region, a deploy target, whatever the pipeline you drafted reads. `variables` maps names ' +
          'to values (created, or changed when different); `remove` names variables to take away. ' +
          'Only the names you give are touched. Never put a secret here: a token, password or key ' +
          'belongs in a secured variable the person adds on the project’s Pipelines page, so name the ' +
          'ones the pipeline needs in your answer and ask them to add those. A secured variable ' +
          'cannot be changed or removed from here, and a name that reads as a secret is refused. ' +
          'Pass environment to write one deployment environment’s set instead of the repository’s.',
        inputSchema: {
          type: 'object',
          properties: {
            environment: environmentProperty,
            variables: {
              type: 'object',
              additionalProperties: { type: 'string', maxLength: 32_000 },
              description: 'Variable names to values.',
            },
            remove: {
              type: 'array',
              items: { type: 'string', maxLength: NAME_MAX },
              maxItems: 100,
              description: 'Variable names to remove.',
            },
          },
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const needs = missingScope(await grantScopes(context.subject, host), writeScope, host);
        if (needs) return errorResult(needs);
        const wanted = {
          variables: variablesOf(input.variables),
          remove: (Array.isArray(input.remove) ? input.remove : [])
            .map((name) => asText(name).trim())
            .filter(Boolean),
        };
        if (Object.keys(wanted.variables).length === 0 && wanted.remove.length === 0) {
          return errorResult('Nothing to do: give variables to set, or names to remove.');
        }
        const environmentName = asText(input.environment).trim();
        const read = await readSets(deps, context.subject);
        if (!read.ok) return errorResult(read.error);
        const environment = environmentName
          ? read.sets.environments.find((entry) => entry.name === environmentName)
          : null;
        if (environmentName && !environment)
          return textResult(renderSets(read.sets, environmentName));
        const current = environmentName
          ? [...(environment?.variables ?? []), ...(environment?.secrets ?? [])]
          : [...read.sets.repository, ...read.sets.repositorySecrets];
        const plan = planVariableWrite(current, wanted, (key, value) => {
          const checked =
            host === GITHUB
              ? validateActionsVariable(key, value)
              : validateVariableInput({ key, value });
          return checked.ok ? null : checked.message;
        });
        const applied = await apply(deps, context.subject, environmentName, current, plan);
        if (applied.added.length || applied.changed.length || applied.removed.length) {
          recordAuditEvent({
            actorSubject: context.subject,
            action:
              host === GITHUB
                ? 'code.actions.variables.replaced'
                : 'code.pipelines.variables.replaced',
            targetKind: 'code_project',
            targetLabel: deps.repoFullName,
            details: {
              projectId: context.projectId,
              repository: deps.repoFullName,
              environment: environmentName || null,
              via: 'chat',
              added: applied.added,
              changed: applied.changed,
              removed: applied.removed,
            },
          });
        }
        return textResult(renderWriteOutcome(plan, applied));
      },
    },
  ];
}

async function apply(
  deps: PipelineToolDeps,
  subject: string,
  environmentName: string,
  current: PipelineVariable[],
  plan: VariableWritePlan
): Promise<VariablesApplied> {
  const entries = plan.set.map(({ key, value }) => ({ key, value, secured: false }));
  const byKey = new Map(current.map((variable) => [variable.key, variable]));
  if (deps.repoProvider === GITHUB) {
    const auth = githubAuthOf({ subject, origin: deps.origin });
    const env = environmentName || undefined;
    const applied = await applyActionsVariables(
      auth,
      deps.repoFullName,
      env,
      current.filter((variable) => !variable.secured),
      entries,
      { prune: false }
    );
    for (const key of plan.remove) {
      const removed = await deleteActionsVariable(auth, deps.repoFullName, env, key);
      if (removed.ok) applied.removed.push(key);
      else applied.errors.push(`${key}: ${removed.error}`);
    }
    return applied;
  }
  const auth = bitbucketAuthOf({ subject, origin: deps.origin });
  // Bitbucket's environment is addressed by uuid; the person and the model say its name.
  const base = repoBase(deps.repoFullName);
  let environmentUuid: string | undefined;
  if (environmentName && base) {
    const environments = await readEnvironments(auth, base);
    environmentUuid = environments.environments.find(
      (entry) => entry.name === environmentName
    )?.uuid;
    if (!environmentUuid) {
      return {
        added: [],
        changed: [],
        removed: [],
        errors: [`environment “${environmentName}” was not found`],
      };
    }
  }
  const applied = await applyVariableText(
    auth,
    deps.repoFullName,
    environmentUuid,
    current,
    entries,
    { prune: false }
  );
  for (const key of plan.remove) {
    const found = byKey.get(key);
    if (!found) continue;
    const removed = await deletePipelineVariable(
      auth,
      deps.repoFullName,
      found.uuid,
      environmentUuid
    );
    if (removed.ok) applied.removed.push(key);
    else applied.errors.push(`${key}: ${removed.error}`);
  }
  return applied;
}
