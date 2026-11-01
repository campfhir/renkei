/**
 * The new-code-project form (new-code-project.tsx): the git host, the
 * repository chosen or created, the name, branch, pasted `.env`, the
 * tools, the template picker and the instructions.
 *
 * The component reads the hosts' lists, makes the creates and navigates;
 * what each choice does to the rest of the form, when Create is allowed,
 * what it sends and where it goes after, which listing a search reads,
 * and what "Create repository" makes are here, tested in
 * new-code-project.model.test.ts. The `.env` is sent exactly as pasted:
 * it is parsed on the server (packages/connector-sandbox's dotenv), whose
 * complaints come back as `envProblems` for the project page to show.
 */

import type { RepoChoice } from '@/lib/code/bitbucket-browse';
import type { CodeProjectTemplate } from '@/lib/code/project-templates';
import { repoSlugFromName } from '@/lib/code/repo-slug';

/** A code project's repository provider, as provider_grants and repo_provider name it. */
export type RepoProvider = 'atlassian-bitbucket' | 'github';

export interface Connected {
  bitbucketConnected: boolean;
  githubConnected: boolean;
}

export interface NewProjectState {
  provider: RepoProvider;
  repoMode: 'choose' | 'create';
  chosen: RepoChoice | null;
  name: string;
  branch: string;
  env: string;
  instructions: string;
  /** null until the catalog answers. */
  templates: CodeProjectTemplate[] | null;
  /** The picker's own choice: the instructions may move on from it. */
  templateId: string;
  /** null: the project inherits the person's default tools for code projects. */
  connectors: string[] | null;
  busy: boolean;
  error: string | null;
}

export type NewProjectAction =
  | { type: 'provider'; provider: RepoProvider }
  | { type: 'repoMode'; mode: 'choose' | 'create' }
  /** A repository browsed to, or just created. */
  | { type: 'chosen'; repo: RepoChoice }
  | { type: 'chooseAnother' }
  | { type: 'name'; value: string }
  | { type: 'branch'; value: string }
  | { type: 'env'; value: string }
  | { type: 'instructions'; value: string }
  | { type: 'templatesLoaded'; templates: CodeProjectTemplate[] }
  | { type: 'template'; templateId: string }
  | { type: 'connectors'; connectors: string[] | null }
  | { type: 'sent' }
  | { type: 'failed'; error: string };

export function initialNewProject(
  connected: Connected & { instructions: string }
): NewProjectState {
  return {
    // Whichever host is connected; both (or neither) starts on Bitbucket.
    provider:
      connected.bitbucketConnected || !connected.githubConnected ? 'atlassian-bitbucket' : 'github',
    repoMode: 'choose',
    chosen: null,
    name: '',
    branch: '',
    env: '',
    instructions: connected.instructions,
    templates: null,
    templateId: '',
    connectors: null,
    busy: false,
    error: null,
  };
}

export function newProjectReducer(
  state: NewProjectState,
  action: NewProjectAction
): NewProjectState {
  switch (action.type) {
    case 'provider':
      if (action.provider === state.provider) return state;
      // A repository of the other host is no choice here.
      return { ...state, provider: action.provider, chosen: null, branch: '' };
    case 'repoMode':
      return { ...state, repoMode: action.mode };
    case 'chosen':
      // The repository names the project until the person types over it:
      // a value, not a placeholder, so it is what gets created.
      return { ...state, chosen: action.repo, name: state.name || action.repo.name };
    case 'chooseAnother':
      return { ...state, chosen: null, branch: '' };
    case 'name':
      return { ...state, name: action.value };
    case 'branch':
      return { ...state, branch: action.value };
    case 'env':
      return { ...state, env: action.value };
    case 'instructions':
      return { ...state, instructions: action.value };
    case 'templatesLoaded':
      return { ...state, templates: action.templates };
    case 'template': {
      const template = state.templates?.find((entry) => entry.id === action.templateId);
      // "Pick a template…" leaves the text alone.
      return {
        ...state,
        templateId: action.templateId,
        instructions: template ? template.instructions : state.instructions,
      };
    }
    case 'connectors':
      return { ...state, connectors: action.connectors };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
  }
}

/** The chosen host is connected for this person. */
export function isConnected(state: NewProjectState, connected: Connected): boolean {
  return state.provider === 'github' ? connected.githubConnected : connected.bitbucketConnected;
}

/** The host switch shows only when both are connected. */
export function showsHostSwitch(connected: Connected): boolean {
  return connected.bitbucketConnected && connected.githubConnected;
}

export function canCreate(state: NewProjectState, connected: Connected): boolean {
  return !state.busy && isConnected(state, connected) && state.chosen !== null;
}

/** What Create project sends; null until a repository is chosen. */
export function createRequest(state: NewProjectState): {
  name: string;
  provider: RepoProvider;
  repository: string;
  branch: string;
  env: string;
  instructions: string;
  toolConfig?: { connectors: string[] };
} | null {
  if (!state.chosen) return null;
  return {
    name: state.name.trim() || state.chosen.name,
    provider: state.provider,
    repository: state.chosen.fullName,
    branch: state.branch.trim(),
    env: state.env,
    instructions: state.instructions.trim(),
    ...(state.connectors ? { toolConfig: { connectors: state.connectors } } : {}),
  };
}

/** Where a created project opens: its page, carrying any `.env` lines the server could not read. */
export function createdUrl(projectId: string, envProblems: string[]): string {
  return `/code/${projectId}${
    envProblems.length ? `?envProblems=${encodeURIComponent(envProblems.join('\n'))}` : ''
  }`;
}

/** The branch field's hint: the repository's main branch. */
export function branchPlaceholder(state: NewProjectState): string {
  return state.chosen?.mainBranch ?? 'main branch';
}

/** The template picker shows once the catalog has anything in it. */
export function showsTemplates(state: NewProjectState): boolean {
  return state.templates !== null && state.templates.length > 0;
}

export function hostLabel(provider: RepoProvider): string {
  return provider === 'github' ? 'GitHub' : 'Bitbucket';
}

/**
 * The repository listing a browse reads, from the owner (workspace or
 * account), the Bitbucket project and the search text; null when there
 * is nothing to list yet.
 */
export function repoListUrl(input: {
  provider: RepoProvider;
  owner: string;
  project: string;
  query: string;
}): string | null {
  const query = input.query.trim();
  if (!input.owner && !query) return null;
  const isGitHub = input.provider === 'github';
  const parts = isGitHub
    ? [
        input.owner ? `account=${encodeURIComponent(input.owner)}` : '',
        query ? `q=${encodeURIComponent(query)}` : '',
      ]
    : [
        input.owner ? `workspace=${encodeURIComponent(input.owner)}` : '',
        input.project ? `project=${encodeURIComponent(input.project)}` : '',
        query ? `q=${encodeURIComponent(query)}` : '',
      ];
  const path = isGitHub ? '/api/code/github/repos' : '/api/code/repos';
  return `${path}?${parts.filter(Boolean).join('&')}`;
}

/** "Create repository": what it makes, whether it may, and the request. */
export function createRepository(input: {
  provider: RepoProvider;
  owner: string;
  project: string;
  name: string;
}): {
  slug: string;
  canCreate: boolean;
  hint: string;
  request: { url: string; body: Record<string, string> };
} {
  const isGitHub = input.provider === 'github';
  const slug = repoSlugFromName(input.name);
  const name = input.name.trim();
  return {
    slug,
    canCreate: isGitHub
      ? Boolean(input.owner && slug)
      : Boolean(input.owner && input.project && slug),
    hint:
      name && input.owner
        ? `Creates ${input.owner}/${slug || '…'} — empty and private.`
        : 'An empty, private repository — the first chat clones it once it has something to work with.',
    request: isGitHub
      ? { url: '/api/code/github/repos', body: { account: input.owner, name } }
      : {
          url: '/api/code/bitbucket/repos',
          body: { workspace: input.owner, project: input.project, name },
        },
  };
}
