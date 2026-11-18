/**
 * A code project's pipeline (migration 185): the spec as JSON the store
 * keeps as given (@renkei/ci-blocks reads and checks it), the host it was
 * built for, and the file as the builder last put it in a pull request.
 */

export interface CiPipelineRecord {
  projectId: string;
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
  get(projectId: string): Promise<CiPipelineRecord | null>;
  /** Every project's pipeline, by project id. */
  list(): Promise<CiPipelineRecord[]>;
  /** The pipelines a host's repository reports for, the last saved first (ties by project id). */
  findByRepoKey(host: string, repoKey: string): Promise<CiPipelineRecord[]>;
  /** Record how the host names the project's repository. False when the project has no pipeline. */
  setRepoKey(projectId: string, repoKey: string): Promise<boolean>;
  /** Create the project's pipeline, or replace its spec and host; what was written is kept. */
  save(projectId: string, input: { host: string; spec: unknown; updatedBy: string }): Promise<void>;
  /** Record the file a pull request carried. False when the project has no pipeline. */
  markWritten(
    projectId: string,
    input: { text: string; pullRequestUrl: string | null }
  ): Promise<boolean>;
}
