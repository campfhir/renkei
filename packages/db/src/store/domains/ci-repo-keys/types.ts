/**
 * How a host's tokens name a code project's repository (migration 192):
 * GitHub's `owner/name`, lower case; Bitbucket's repository UUID, without
 * braces. One a project; a deploy step's report finds its project by it.
 */

export interface CiRepoKeyStore {
  /** Record how the host names the project's repository, in place of what was recorded. */
  set(projectId: string, host: string, repoKey: string): Promise<void>;
  /** The projects a host's repository reports for, the last recorded first (ties by project id). */
  projectsFor(host: string, repoKey: string): Promise<string[]>;
}
