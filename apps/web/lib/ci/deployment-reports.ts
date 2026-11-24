/**
 * A deployment report from a pipeline's deploy step (POST
 * /api/deployments/report; the step's command is @renkei/ci-blocks'
 * report.ts): the host's token says which repository is reporting
 * (oidc.ts), the code project whose builder wrote that repository's
 * pipeline is found by it, and the body says which environment, commit and
 * target, and how it went. What the token says wins over the body where
 * both say it (GitHub's commit, branch and run).
 */

import { getDataStore, type CiDeploymentStatus } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { getProjectRow } from '@/lib/chat/projects';
import { projectEnvironments } from './environments';
import { reportTo } from './pipeline-builder';
import { verifyPipelineToken, type KeysFor, type PipelineIdentity } from './oidc';

export interface ReportBody {
  environment: string;
  status: CiDeploymentStatus;
  commit: string;
  branch: string | null;
  run: string | null;
  target: string | null;
  detail: string | null;
}

const STATUSES: CiDeploymentStatus[] = ['started', 'succeeded', 'failed'];
const field = (body: Record<string, unknown>, name: string) =>
  typeof body[name] === 'string' ? body[name].trim() : '';

/** The body a deploy step sends, checked; what is wrong with it otherwise. */
export function readReportBody(
  value: unknown
): { ok: true; body: ReportBody } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'The report is not JSON.' };
  const environment = field(value, 'environment');
  const status = STATUSES.find((s) => s === field(value, 'status'));
  const commit = field(value, 'commit');
  const branch = field(value, 'branch');
  const run = field(value, 'run');
  const target = field(value, 'target');
  const detail = field(value, 'detail')
    .replace(/\p{Cc}+/gu, ' ')
    .slice(0, 200);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(environment))
    return { ok: false, error: 'Say which environment deployed.' };
  if (!status) return { ok: false, error: 'Say whether it started, succeeded or failed.' };
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return { ok: false, error: 'Say which commit deployed.' };
  return {
    ok: true,
    body: {
      environment,
      status,
      commit: commit.toLowerCase(),
      branch: /^[A-Za-z0-9._/-]{1,255}$/.test(branch) ? branch : null,
      run: /^[0-9]{1,20}(\.[0-9]{1,6})?$/.test(run) ? run : null,
      target: /^[a-z][a-z0-9-]{1,49}$/.test(target) ? target : null,
      detail: detail || null,
    },
  };
}

function runUrl(identity: PipelineIdentity, fullName: string, run: string | null): string | null {
  if (!run) return null;
  const [owner, name] = fullName.split('/').map(encodeURIComponent);
  const id = run.split('.')[0];
  return identity.host === 'github'
    ? `https://github.com/${owner}/${name}/actions/runs/${id}`
    : `https://bitbucket.org/${owner}/${name}/pipelines/results/${id}`;
}

export type ReportOutcome =
  | {
      ok: true;
      projectId: string;
      project: string;
      repository: string;
      host: PipelineIdentity['host'];
      environment: string;
      status: CiDeploymentStatus;
      commit: string;
    }
  | { ok: false; status: number; error: string };

export async function recordDeploymentReport(input: {
  authorization: string | null;
  body: unknown;
  origin: string;
  now: Date;
  keysFor?: KeysFor;
}): Promise<ReportOutcome> {
  const token = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? '')?.[1];
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'Send the pipeline step’s OpenID Connect token as a bearer token.',
    };
  }
  const audience = reportTo(input.origin)?.audience ?? '';
  const verified = await verifyPipelineToken(token, audience, input.keysFor);
  if (!verified.ok) return { ok: false, status: 401, error: verified.error };
  const identity = verified.identity;
  const read = readReportBody(input.body);
  if (!read.ok) return { ok: false, status: 400, error: read.error };
  const body = read.body;

  const pipelines = await getDataStore().ciPipelines.findByRepoKey(identity.host, identity.repoKey);
  const pipeline = pipelines.find((p) => p.writtenText !== null) ?? pipelines[0];
  const project = pipeline ? await getProjectRow(pipeline.projectId) : null;
  if (!pipeline || !project?.repo) {
    return {
      ok: false,
      status: 404,
      error: 'No code project in Renkei built the pipeline for this repository.',
    };
  }
  const known = (await projectEnvironments(project.id)).find(
    (e) => e.name.toLowerCase() === body.environment.toLowerCase()
  );
  if (!known) {
    return {
      ok: false,
      status: 400,
      error: `The project Renkei keeps for ${project.repo.fullName} has no environment ${body.environment}.`,
    };
  }
  const run = identity.host === 'github' ? (identity.run ?? body.run) : body.run;
  const commit = identity.host === 'github' ? (identity.sha ?? body.commit) : body.commit;
  await getDataStore().ciDeployments.record({
    projectId: project.id,
    environment: known.name,
    status: body.status,
    commitSha: commit.toLowerCase(),
    branch: identity.branch ?? body.branch,
    target: body.target,
    // Without a run, each report is its own row, at its own instant.
    runId: `${identity.host}:${run ?? `at-${input.now.getTime()}`}`,
    runUrl: runUrl(identity, project.repo.fullName, run),
    detail: body.detail,
    actor: identity.host === 'github' ? identity.actor : null,
    at: input.now,
  });
  return {
    ok: true,
    projectId: project.id,
    project: project.name,
    repository: project.repo.fullName,
    host: identity.host,
    environment: known.name,
    status: body.status,
    commit,
  };
}
