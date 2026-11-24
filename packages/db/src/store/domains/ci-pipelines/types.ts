/**
 * A code project's pipelines (migrations 185 and 191), one per branch: a
 * pipeline file lives on a branch, so the builder keeps one for each. The
 * spec is JSON the store keeps as given (@renkei/ci-blocks reads and
 * checks it), with the host it was built for and the file as the builder
 * last put it in a pull request against that branch.
 */

export interface CiPipelineRecord {
  projectId: string;
  /** The branch the pipeline's file lives on. */
  branch: string;
  host: string;
  spec: unknown;
  /** The file as the builder last wrote it; null until it has. */
  writtenText: string | null;
  writtenAt: Date | null;
  pullRequestUrl: string | null;
  /** The repository as its host's tokens name it (migration 186); null until known. */
  repoKey: string | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CiPipelineStore {
  get(projectId: string, branch: string): Promise<CiPipelineRecord | null>;
  /** The project's pipelines, by branch. */
  listForProject(projectId: string): Promise<CiPipelineRecord[]>;
  /** The pipelines a host's repository reports for, the last saved first (ties by project id, then branch). */
  findByRepoKey(host: string, repoKey: string): Promise<CiPipelineRecord[]>;
  /** Record how the host names the project's repository, on each of its pipelines. False when it has none. */
  setRepoKey(projectId: string, repoKey: string): Promise<boolean>;
  /** Create the branch's pipeline, or replace its spec and host; what was written is kept. */
  save(
    projectId: string,
    branch: string,
    input: { host: string; spec: unknown; updatedBy: string }
  ): Promise<void>;
  /** Record the file a pull request carried. False when the branch has no pipeline. */
  markWritten(
    projectId: string,
    branch: string,
    input: { text: string; pullRequestUrl: string | null }
  ): Promise<boolean>;
}
