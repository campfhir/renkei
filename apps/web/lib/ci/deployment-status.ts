/**
 * How a person's code projects stand, for the tools that answer a chat or
 * an agent (lib/mcp-tools/deployments): each project's environments with
 * their branches, the last deployment a pipeline reported, what is running
 * there, and how the deployed application says it is — the same reading
 * the Environments page shows (health-rules.ts), from Renkei's own rows.
 *
 * Nothing here calls a code host, and nothing here is secret: no variable,
 * no token (not even its hint), no pipeline text. A project is the
 * person's when they own it or it is shared with them.
 */

import { getDataStore, type CiDeploymentRecord } from '@renkei/db';
import { listAccessibleProjectIds } from '@/lib/chat/access';
import { listProjectsById, type ProjectRow } from '@/lib/chat/projects';
import { projectEnvironments } from './environments';
import { healthView } from './health';
import { readHealth, spanLabel, type HealthState } from './health-rules';

export interface DeploymentLine {
  status: string;
  commit: string;
  branch: string | null;
  runUrl: string | null;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface EnvironmentStatus {
  name: string;
  production: boolean;
  branches: string[];
  /** The last deployment reported, whatever came of it. */
  latest: DeploymentLine | null;
  /** The last one that succeeded: what runs there. */
  running: DeploymentLine | null;
  /** Null when the application has never been given a way to check in. */
  health: {
    state: HealthState;
    missed: number;
    message: string | null;
    version: string | null;
    lastCheckIn: string | null;
    nextDue: string | null;
    every: string;
  } | null;
}

export interface ProjectStatus {
  id: string;
  name: string;
  repository: string;
  environments: EnvironmentStatus[];
}

function line(record: CiDeploymentRecord): DeploymentLine {
  return {
    status: record.status,
    commit: record.commitSha,
    branch: record.branch,
    runUrl: record.runUrl,
    detail: record.detail,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
  };
}

/** The code projects this person can open — all of them, or the one asked for. */
export async function codeProjectsOf(subject: string, projectId?: string): Promise<ProjectRow[]> {
  const ids = await listAccessibleProjectIds(subject);
  const wanted = projectId ? ids.filter((id) => id === projectId) : ids;
  return (await listProjectsById(wanted, { orderBy: 'name' })).filter((p) => p.repo !== null);
}

const HISTORY = 50;

export async function projectStatus(project: ProjectRow, now: Date): Promise<ProjectStatus> {
  const store = getDataStore();
  const [environments, deployments, health] = await Promise.all([
    projectEnvironments(project.id),
    store.ciDeployments.recent([project.id], HISTORY),
    store.ciHealth.listForProject(project.id),
  ]);
  return {
    id: project.id,
    name: project.name,
    repository: project.repo?.fullName ?? '',
    environments: environments.map((environment) => {
      const same = (name: string) => name.toLowerCase() === environment.name.toLowerCase();
      const here = deployments.filter((d) => same(d.environment));
      const running = here.find((d) => d.status === 'succeeded');
      const checkins = health.find((h) => same(h.environment));
      const view = checkins ? healthView(checkins) : null;
      const reading = view ? readHealth(view, now.getTime()) : null;
      return {
        name: environment.name,
        production: environment.production,
        branches: environment.branches,
        latest: here[0] ? line(here[0]) : null,
        running: running ? line(running) : null,
        health:
          view && reading
            ? {
                state: reading.state,
                missed: reading.missed,
                message: view.message,
                version: view.version,
                lastCheckIn: view.sentAt,
                nextDue: reading.dueAt,
                every: spanLabel(reading.intervalSeconds),
              }
            : null,
      };
    }),
  };
}

/** One project's deployments as pipelines reported them, newest first. */
export async function deploymentHistory(
  projectId: string,
  environment: string | null,
  limit: number
): Promise<(DeploymentLine & { environment: string })[]> {
  const rows = await getDataStore().ciDeployments.recent([projectId], environment ? 200 : limit);
  return rows
    .filter((d) => !environment || d.environment.toLowerCase() === environment.toLowerCase())
    .slice(0, limit)
    .map((d) => ({ environment: d.environment, ...line(d) }));
}

const HEALTH_WORDS: Record<HealthState, string> = {
  waiting: 'no check-in yet',
  starting: 'starting',
  healthy: 'healthy',
  degraded: 'degraded',
  error: 'error',
  stopping: 'stopping',
  late: 'potentially failing (a check-in is overdue)',
  failed: 'failed (stopped checking in)',
  stopped: 'stopped',
};

function deploymentWords(d: DeploymentLine): string {
  const parts = [
    `${d.status}`,
    `commit ${d.commit.slice(0, 7)}`,
    d.branch ? `from ${d.branch}` : '',
    `at ${d.finishedAt ?? d.startedAt}`,
    d.detail ? `— ${d.detail}` : '',
    d.runUrl ? `(${d.runUrl})` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** The status as a model reads it: plain lines, one project after another. */
export function statusText(projects: ProjectStatus[]): string {
  if (projects.length === 0) return 'No code project of yours has anything to show.';
  const lines: string[] = [];
  for (const project of projects) {
    lines.push(`Project "${project.name}" (${project.repository}) — id ${project.id}`);
    for (const environment of project.environments) {
      const branches = environment.branches.length
        ? `branches: ${environment.branches.join(', ')}`
        : 'no branch assigned';
      lines.push(
        `  ${environment.name}${environment.production ? ' (production)' : ''} — ${branches}`
      );
      lines.push(
        `    last deployment: ${environment.latest ? deploymentWords(environment.latest) : 'none reported'}`
      );
      if (environment.running && environment.running !== environment.latest) {
        lines.push(`    running: ${deploymentWords(environment.running)}`);
      }
      const health = environment.health;
      if (!health) {
        lines.push('    health: the application does not check in');
      } else {
        const said = [
          HEALTH_WORDS[health.state],
          health.missed > 0 ? `${health.missed} check-in(s) missed` : '',
          health.lastCheckIn ? `last check-in ${health.lastCheckIn}` : '',
          health.nextDue ? `next due ${health.nextDue} (every ${health.every})` : '',
          health.version ? `version ${health.version}` : '',
          health.message ? `said: ${health.message}` : '',
        ];
        lines.push(`    health: ${said.filter(Boolean).join('; ')}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
