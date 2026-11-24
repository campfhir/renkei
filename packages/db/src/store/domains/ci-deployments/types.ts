/**
 * Deployments as pipelines report them (migration 186): one row per run of
 * a step deploying an environment of a code project, written when it
 * starts and updated when it ends. The caller says when (`at`), so a row
 * is the same in either store.
 */

export type CiDeploymentStatus = 'started' | 'succeeded' | 'failed';

export interface CiDeploymentRecord {
  id: string;
  projectId: string;
  environment: string;
  status: string;
  commitSha: string;
  branch: string | null;
  target: string | null;
  /** The host's run, `bitbucket:412` or `github:2231.1`. */
  runId: string;
  runUrl: string | null;
  detail: string | null;
  /** Who set the run going, when the host says. */
  actor: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface CiDeploymentReport {
  projectId: string;
  environment: string;
  status: CiDeploymentStatus;
  commitSha: string;
  branch: string | null;
  target: string | null;
  runId: string;
  runUrl: string | null;
  detail: string | null;
  actor: string | null;
  at: Date;
}

export interface CiDeploymentStore {
  /**
   * A run's report: a new row when it is the run's first for that
   * environment, else the row updated — its outcome, what it says, and
   * when it finished. A start reported after the end does not undo it.
   * Answers the row's id.
   */
  record(report: CiDeploymentReport): Promise<string>;
  /** Each project's newest deployment of each environment, by project, then environment. */
  latest(projectIds: string[]): Promise<CiDeploymentRecord[]>;
  /** The newest deployments across the projects, newest first (ties by id). */
  recent(projectIds: string[], limit: number): Promise<CiDeploymentRecord[]>;
}
