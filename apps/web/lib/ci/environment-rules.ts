/**
 * A code project's environments and the branches assigned to them — the
 * rules, with nothing of the server in them, so the Environments page's
 * model and the route that saves the list decide alike. Tested in
 * environment-rules.test.ts.
 *
 * A project names its environments as it likes (dev, staging, test, …) and
 * assigns branches of its repository to them: a pipeline file lives on a
 * branch, so the branch is what an environment's pipeline, runs and
 * variables hang from. Exactly one environment is the production one. It
 * holds at most one branch — assigning another replaces it — where any
 * other environment holds as many as it likes. A branch sits in one
 * environment.
 */

import { isRecord } from '@renkei/guards';

export interface ProjectEnvironment {
  name: string;
  /** True for the project's one production environment. */
  production: boolean;
  /** The branches assigned, in the order they were. */
  branches: string[];
}

export const MAX_PROJECT_ENVIRONMENTS = 12;
export const MAX_ENVIRONMENT_BRANCHES = 20;
const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const BRANCH_NAME = /^(?!\/|.*\/\/|.*\.\.|.*\/$)[A-Za-z0-9._/-]{1,200}$/;

/** What a project starts with: its production environment, no branch assigned yet. */
export function defaultEnvironments(): ProjectEnvironment[] {
  return [{ name: 'production', production: true, branches: [] }];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A stored list made one the rules hold for: exactly one production
 * environment (the first marked so; else the one named production; else a
 * new one in front), at most one branch on it, and each branch in the
 * first environment that names it.
 */
export function normalizeEnvironments(list: readonly ProjectEnvironment[]): ProjectEnvironment[] {
  if (list.length === 0) return defaultEnvironments();
  const marked = list.findIndex((e) => e.production);
  const named = list.findIndex((e) => same(e.name, 'production'));
  const production = marked >= 0 ? marked : named;
  const seen = new Set<string>();
  const out = list.map((environment, index) => {
    const isProduction = index === production;
    const branches = environment.branches
      .filter((branch) => !seen.has(branch) && (seen.add(branch), true))
      .slice(0, isProduction ? 1 : MAX_ENVIRONMENT_BRANCHES);
    return { name: environment.name, production: isProduction, branches };
  });
  return production >= 0 ? out : [...defaultEnvironments(), ...out];
}

/** Why a name cannot be an environment's; null when it can. `except` is the one being renamed. */
export function environmentNameProblem(
  list: readonly ProjectEnvironment[],
  name: string,
  except?: string
): string | null {
  const wanted = name.trim();
  if (!wanted) return 'Give the environment a name.';
  if (!ENVIRONMENT_NAME.test(wanted)) {
    return 'A name starts with a letter and holds letters, digits, - and _, up to 40.';
  }
  if (list.some((e) => same(e.name, wanted) && !(except && same(e.name, except)))) {
    return `There is already an environment named ${wanted}.`;
  }
  return null;
}

/** Every problem with a whole list, in a person's words; none when it can be saved. */
export function environmentProblems(
  list: readonly ProjectEnvironment[],
  options: {
    /** The repository's branches as its host lists them; null when it could not say. */
    remoteBranches?: readonly string[] | null;
    /** Branches already assigned before this save: kept even when the host no longer lists them. */
    assignedBefore?: readonly string[];
  } = {}
): string[] {
  const problems: string[] = [];
  if (list.length === 0) problems.push('A project keeps its production environment.');
  if (list.length > MAX_PROJECT_ENVIRONMENTS) {
    problems.push(`A project has at most ${MAX_PROJECT_ENVIRONMENTS} environments.`);
  }
  const names = new Set<string>();
  for (const environment of list) {
    const name = environment.name.trim();
    if (!ENVIRONMENT_NAME.test(name)) {
      problems.push(
        `“${name || 'An environment'}” is not a usable environment name: it starts with a letter and holds letters, digits, - and _.`
      );
    } else if (names.has(name.toLowerCase())) {
      problems.push(`Two environments are named ${name}.`);
    }
    names.add(name.toLowerCase());
  }
  const production = list.filter((e) => e.production);
  if (list.length > 0 && production.length === 0) {
    problems.push('One environment is the production one; none is marked so.');
  }
  if (production.length > 1) {
    problems.push(
      `Only one environment is the production one; ${production.map((e) => e.name).join(' and ')} are both marked so.`
    );
  }
  for (const environment of production) {
    if (environment.branches.length > 1) {
      problems.push(
        `${environment.name} is the production environment and deploys from one branch; it was given ${environment.branches.join(' and ')}.`
      );
    }
  }
  const owner = new Map<string, string>();
  const before = new Set(options.assignedBefore ?? []);
  const remote = options.remoteBranches ? new Set(options.remoteBranches) : null;
  for (const environment of list) {
    if (environment.branches.length > MAX_ENVIRONMENT_BRANCHES) {
      problems.push(
        `${environment.name} has more than ${MAX_ENVIRONMENT_BRANCHES} branches assigned.`
      );
    }
    for (const branch of environment.branches) {
      if (!BRANCH_NAME.test(branch)) {
        problems.push(`“${branch}” is not a branch name.`);
        continue;
      }
      const taken = owner.get(branch);
      if (taken !== undefined) {
        problems.push(
          taken === environment.name
            ? `${branch} is assigned to ${environment.name} twice.`
            : `${branch} is assigned to both ${taken} and ${environment.name}; a branch deploys one environment.`
        );
        continue;
      }
      owner.set(branch, environment.name);
      if (remote && !remote.has(branch) && !before.has(branch)) {
        problems.push(
          `The repository has no branch ${branch}; an environment is assigned branches that exist on the remote.`
        );
      }
    }
  }
  return problems;
}

/** The environment a branch is assigned to, or null. */
export function environmentOfBranch(
  list: readonly ProjectEnvironment[],
  branch: string
): ProjectEnvironment | null {
  return list.find((e) => e.branches.includes(branch)) ?? null;
}

/** Every branch assigned to any environment. */
export function assignedBranches(list: readonly ProjectEnvironment[]): string[] {
  return list.flatMap((e) => e.branches);
}

// ——— the edits the page makes; each answers the new list ———

export function withEnvironment(
  list: readonly ProjectEnvironment[],
  name: string
): ProjectEnvironment[] {
  return [...list, { name: name.trim(), production: false, branches: [] }];
}

export function withoutEnvironment(
  list: readonly ProjectEnvironment[],
  name: string
): ProjectEnvironment[] {
  return list.filter((e) => e.production || !same(e.name, name));
}

export function renamed(
  list: readonly ProjectEnvironment[],
  from: string,
  to: string
): ProjectEnvironment[] {
  return list.map((e) => (same(e.name, from) ? { ...e, name: to.trim() } : e));
}

/**
 * The list with the branch assigned to the environment: taken from the
 * environment that had it, and — on the production environment — in place
 * of the branch that was there.
 */
export function withBranch(
  list: readonly ProjectEnvironment[],
  environment: string,
  branch: string
): ProjectEnvironment[] {
  return list.map((e) => {
    const without = e.branches.filter((b) => b !== branch);
    if (!same(e.name, environment)) return { ...e, branches: without };
    return { ...e, branches: e.production ? [branch] : [...without, branch] };
  });
}

export function withoutBranch(
  list: readonly ProjectEnvironment[],
  environment: string,
  branch: string
): ProjectEnvironment[] {
  return list.map((e) =>
    same(e.name, environment) ? { ...e, branches: e.branches.filter((b) => b !== branch) } : e
  );
}

/** A sent list read for shape; the rules are environmentProblems'. */
export function readEnvironmentList(value: unknown): ProjectEnvironment[] | null {
  if (!Array.isArray(value)) return null;
  const out: ProjectEnvironment[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { name, production, branches } = raw;
    if (typeof name !== 'string' || !Array.isArray(branches)) return null;
    if (!branches.every((branch): branch is string => typeof branch === 'string')) return null;
    out.push({
      name: name.trim(),
      production: production === true,
      branches: branches.map((branch) => branch.trim()),
    });
  }
  return out;
}
