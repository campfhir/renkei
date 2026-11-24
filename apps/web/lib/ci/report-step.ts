/**
 * The report step for a pipeline written by hand: what a person copies
 * into the step that deploys an environment so that Renkei shows what
 * runs there, as it does for a pipeline built from blocks
 * (@renkei/ci-blocks report.ts writes both).
 *
 * A report carries no secret — the host signs a token for the step — so
 * all Renkei needs is to know which project a repository's reports are
 * for. Taking the step records that: how the host's tokens name the
 * repository (GitHub's `owner/name`; Bitbucket's repository UUID, read
 * with the person's own grant), kept for the project.
 */

import { getDataStore } from '@renkei/db';
import { PIPELINE_FILE, reportSnippet, type Host } from '@renkei/ci-blocks';
import { bitbucketAuthOf } from '@/lib/code/bitbucket-browse';
import { repoBase } from '@/lib/code/bitbucket-pipelines';
import { bbJson } from '@/lib/mcp-tools/bitbucket/client';
import { str } from '@/lib/mcp-tools/github/client';
import { bareUuid } from './oidc';
import { reportTo, type CodeRepoProject } from './pipeline-builder';

export interface ReportStep {
  /** YAML to copy into the pipeline file. */
  snippet: string;
  /** Where it goes, in a sentence. */
  where: string;
  environment: string;
}

export type ReportStepOutcome =
  { ok: true; step: ReportStep } | { ok: false; status: number; error: string };

export async function reportStep(
  caller: { subject: string; origin: string },
  host: Host,
  project: CodeRepoProject,
  environment: string
): Promise<ReportStepOutcome> {
  const to = reportTo(caller.origin);
  if (!to) {
    return {
      ok: false,
      status: 409,
      error:
        'Renkei does not know its own address here, so a pipeline has nowhere to report to; an operator sets the site’s address.',
    };
  }
  let repoKey: string;
  if (host === 'github') {
    repoKey = project.repo.fullName.toLowerCase();
  } else {
    const base = repoBase(project.repo.fullName);
    if (!base) return { ok: false, status: 400, error: 'The repository name is not usable.' };
    const repository = await bbJson(bitbucketAuthOf(caller), ['repository'], base);
    const uuid = repository.ok ? str(repository.body.uuid) : '';
    if (!uuid) {
      return {
        ok: false,
        status: 502,
        error: `Bitbucket did not say how its tokens name this repository${repository.ok ? '' : `: ${repository.error}`}; the report step was not prepared.`,
      };
    }
    repoKey = bareUuid(uuid);
  }
  await getDataStore().ciRepoKeys.set(project.id, host, repoKey);
  return {
    ok: true,
    step: {
      snippet: reportSnippet(host, to, environment),
      environment,
      where:
        host === 'github'
          ? `A job for the workflow that deploys ${environment}: keep its permissions and its first and last steps, and put your own deploy steps where “Deploy” is.`
          : `A step for ${PIPELINE_FILE.bitbucket}, under the branch that deploys ${environment}: keep oidc, the first script line and the after-script, and put your own commands where the placeholder is.`,
    },
  };
}
