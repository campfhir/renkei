/**
 * A code project's environments (migration 191): the names it deploys to
 * — production, dev, staging, whatever it calls them — in the order the
 * project keeps them, each with the repository branches assigned to it.
 * The store keeps the list as given; which lists are allowed (one
 * production environment holding at most one branch, a branch in one
 * environment) is the caller's rule.
 */

export interface CiEnvironmentRecord {
  projectId: string;
  name: string;
  /** True for the project's production environment. */
  production: boolean;
  /** The branches whose pipelines deploy it, in the order they were assigned. */
  branches: string[];
  updatedBy: string;
  updatedAt: Date;
}

export interface CiEnvironmentInput {
  name: string;
  production: boolean;
  branches: string[];
}

export interface CiEnvironmentStore {
  /** The project's environments, in the order they were saved. */
  list(projectId: string): Promise<CiEnvironmentRecord[]>;
  /** Replace the project's whole list with this one, in this order. */
  replace(projectId: string, environments: CiEnvironmentInput[], updatedBy: string): Promise<void>;
}
