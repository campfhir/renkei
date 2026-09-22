'use client';

/**
 * The new-code-project form. The repository is picked from the person's
 * own Bitbucket or GitHub — browsed workspace/account → (Bitbucket only)
 * project → repositories, searched by name across everything they
 * belong to, or created fresh (empty) — never typed by hand for an
 * existing repo; the `.env` is pasted as a file's text and parsed on the
 * server (only the pairs reach the sandbox worker, which seals them, and
 * nothing here shows a value again); the instructions start from a
 * developer's brief. Nothing is cloned yet: the first chat in the
 * project does that.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { DEFAULT_CODE_INSTRUCTIONS } from '@/lib/code/default-instructions';
import { CODE_PROJECT_CONNECTORS } from '@/lib/chat/tool-config';
import ToolsPopover from '../../chat/_components/tools-popover';
import { repoSlugFromName } from '@/lib/code/repo-slug';
import type { BrowseProject, BrowseWorkspace, RepoChoice } from '@/lib/code/bitbucket-browse';
import type { GitHubAccount } from '@/lib/code/github-browse';
import type { CodeProjectTemplate } from '@/lib/code/project-templates';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

/** A code project's repository provider, as provider_grants and repo_provider name it. */
type RepoProvider = 'atlassian-bitbucket' | 'github';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function NewCodeProject({
  slug,
  tenantId,
  bitbucketConnected,
  githubConnected,
}: {
  slug: string;
  tenantId: string;
  bitbucketConnected: boolean;
  githubConnected: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const instructionsAnchor = useCoachAnchor('code-instructions');
  // Defaults to whichever host is connected; both connected starts on
  // Bitbucket and lets the person switch.
  const [provider, setProvider] = useState<RepoProvider>(
    bitbucketConnected || !githubConnected ? 'atlassian-bitbucket' : 'github'
  );
  const connected = provider === 'github' ? githubConnected : bitbucketConnected;
  const [repoMode, setRepoMode] = useState<'choose' | 'create'>('choose');
  const [chosen, setChosen] = useState<RepoChoice | null>(null);
  const [branch, setBranch] = useState('');
  const [env, setEnv] = useState('');
  const [instructions, setInstructions] = useState(DEFAULT_CODE_INSTRUCTIONS);
  const [templates, setTemplates] = useState<CodeProjectTemplate[] | null>(null);
  // Tracks the picker's own selection, separate from `instructions` —
  // once picked, the text is free to diverge as it is edited, and the
  // picker should not silently snap back to matching it.
  const [templateId, setTemplateId] = useState('');
  // null: the project inherits your default for code projects (else the
  // code default) when it is made; a list is this project's own choice.
  const [connectors, setConnectors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getJson<{ templates: CodeProjectTemplate[] }>(
      `/api/tenant/${tenantId}/code/project-templates`
    ).then((result) => setTemplates(result.data?.templates ?? []));
  }, [tenantId]);

  const create = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ projectId: string; envProblems: string[] }>(
      `/api/tenant/${tenantId}/code/projects`,
      'POST',
      {
        name: name.trim() || chosen.name,
        provider,
        repository: chosen.fullName,
        branch: branch.trim(),
        env,
        instructions: instructions.trim(),
        ...(connectors ? { toolConfig: { connectors } } : {}),
      }
    );
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The project could not be created.');
      return;
    }
    const problems = result.data.envProblems;
    router.push(
      `/${slug}/code/${result.data.projectId}${problems.length ? `?envProblems=${encodeURIComponent(problems.join('\n'))}` : ''}`
    );
    router.refresh();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <Link
          href={`/${slug}/code`}
          aria-label="Back to Code"
          title="Back to Code"
          className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
        >
          <Icon path={ICONS.chevronLeft} className="h-5 w-5" />
        </Link>
        <h1 className="flex-1 text-sm font-semibold">New code project</h1>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        className="mx-auto max-w-3xl space-y-4 p-4"
      >
        {bitbucketConnected && githubConnected ? (
          <div role="tablist" aria-label="Git host" className="flex gap-1">
            {(
              [
                ['atlassian-bitbucket', 'Bitbucket'],
                ['github', 'GitHub'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={provider === value}
                onClick={() => {
                  if (provider === value) return;
                  setProvider(value);
                  setChosen(null);
                  setBranch('');
                }}
                className={`rounded-md px-2 py-1 text-xs font-medium ${
                  provider === value
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {!connected ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            Connect {provider === 'github' ? 'GitHub' : 'Bitbucket'} first —{' '}
            <Link href={`/${slug}/connectors`} className="underline">
              on the Connectors page
            </Link>
            . A code project reads and clones its repository with your own access on the
            repository’s host.
          </p>
        ) : null}

        <div className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">Repository</span>
          {chosen ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{chosen.fullName}</span>
              {chosen.mainBranch ? (
                <span className="text-xs text-gray-500">main branch {chosen.mainBranch}</span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setChosen(null);
                  setBranch('');
                }}
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Choose another
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div role="tablist" className="flex gap-1">
                {(['choose', 'create'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={repoMode === tab}
                    onClick={() => setRepoMode(tab)}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      repoMode === tab
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800'
                    }`}
                  >
                    {tab === 'choose' ? 'Choose existing' : 'Create new'}
                  </button>
                ))}
              </div>
              {repoMode === 'choose' ? (
                <RepositoryBrowser
                  key={provider}
                  tenantId={tenantId}
                  provider={provider}
                  enabled={connected}
                  onChoose={(repo) => {
                    setChosen(repo);
                    // The repository names the project until the person
                    // types over it — an initial value, not a placeholder,
                    // so it is part of what gets created and stays theirs
                    // to rename.
                    setName((current) => current || repo.name);
                  }}
                />
              ) : (
                <CreateRepository
                  key={provider}
                  tenantId={tenantId}
                  provider={provider}
                  enabled={connected}
                  onCreated={(repo) => {
                    setChosen(repo);
                    setName((current) => current || repo.name);
                  }}
                />
              )}
            </div>
          )}
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            Name (optional — defaults to the repository’s name)
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={chosen?.name ?? ''}
            maxLength={200}
            className={inputClass}
          />
        </label>

        {chosen ? (
          <label className="block text-sm sm:max-w-xs">
            <span className="mb-1 block text-xs font-medium text-gray-500">Branch (optional)</span>
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder={chosen.mainBranch ?? 'main branch'}
              autoComplete="off"
              spellCheck={false}
              className={`font-mono ${inputClass}`}
            />
            <span className="mt-1 block text-xs text-gray-500">
              The branch the checkout starts on; chats branch from it when a change calls for one.
            </span>
          </label>
        ) : null}

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            .env — the environment the project’s commands run with (optional)
          </span>
          <textarea
            value={env}
            onChange={(event) => setEnv(event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={'NPM_TOKEN=…\nDATABASE_URL=postgres://…\nAPI_BASE_URL=https://…'}
            className={`font-mono ${inputClass}`}
          />
          <span className="mt-1 block text-xs text-gray-500">
            Paste the file as it is. Values are sealed on the sandbox worker and never shown again —
            not here, not to the model; commands get them in their environment, and they are masked
            out of everything the model reads.
          </span>
        </label>

        <div className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            Tools — the connectors chats in this project start with
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <ToolsPopover
              tenantId={tenantId}
              selected={connectors}
              onChange={setConnectors}
              context="project"
              kind="code"
              locked={CODE_PROJECT_CONNECTORS}
              saveDefault
              slug={slug}
            />
            <span className="text-xs text-gray-500">
              {connectors
                ? `${connectors.length} chosen for this project.`
                : 'Inherits your default for code projects (or the code default: Bitbucket, GitHub, Jira, Confluence, knowledge, the sandbox). Saved on the project when it is made; change it on the project’s page later.'}
            </span>
          </div>
        </div>

        {templates && templates.length > 0 ? (
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-gray-500">
              Start from a template
            </span>
            <select
              value={templateId}
              onChange={(event) => {
                const next = event.target.value;
                setTemplateId(next);
                const template = templates.find((entry) => entry.id === next);
                if (template) setInstructions(template.instructions);
              }}
              className={inputClass}
            >
              <option value="">Pick a template…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            Instructions — what every chat in this project should know
          </span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={12}
            maxLength={20_000}
            placeholder="How to run the tests, the conventions to keep, what not to touch…"
            className={inputClass}
            {...instructionsAnchor}
          />
          <span className="mt-1 block text-xs text-gray-500">
            {templates && templates.length > 0
              ? 'Pick a starting point above, then make it this project’s own — add how this repository runs its tests, the conventions to keep, what not to touch.'
              : 'A developer’s standing brief to start from — change it here or on the project’s page later; add how this repository runs its tests, the conventions to keep, what not to touch.'}
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Link
            href={`/${slug}/code`}
            className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={busy || !connected || !chosen}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The workspace → project pair every Bitbucket picker starts from —
 * shared by the "choose existing" browser and the "create new" form, so
 * they stay in sync instead of fetching this twice.
 */
function useWorkspaceAndProject(base: string, enabled: boolean) {
  const [workspaces, setWorkspaces] = useState<BrowseWorkspace[] | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [projects, setProjects] = useState<BrowseProject[] | null>(null);
  const [project, setProject] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    void getJson<{ workspaces: BrowseWorkspace[] }>(`${base}/bitbucket/workspaces`).then(
      (result) => {
        if (result.data) {
          setWorkspaces(result.data.workspaces);
          if (result.data.workspaces.length === 1) setWorkspace(result.data.workspaces[0]!.slug);
        } else setError(result.error ?? 'Bitbucket could not be read.');
      }
    );
  }, [base, enabled]);

  useEffect(() => {
    setProjects(null);
    setProject('');
    if (!workspace) return;
    void getJson<{ projects: BrowseProject[] }>(
      `${base}/bitbucket/projects?workspace=${encodeURIComponent(workspace)}`
    ).then((result) => {
      if (result.data) setProjects(result.data.projects);
      else setError(result.error ?? 'The workspace’s projects could not be read.');
    });
  }, [base, workspace]);

  return { workspaces, workspace, setWorkspace, projects, project, setProject, error };
}

/**
 * The accounts (organizations/user accounts) Renkei's GitHub App is
 * installed on for this person — GitHub's equivalent of a Bitbucket
 * workspace, minus the project layer Bitbucket has and GitHub does not.
 */
function useGitHubAccounts(base: string, enabled: boolean) {
  const [accounts, setAccounts] = useState<GitHubAccount[] | null>(null);
  const [account, setAccount] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    void getJson<{ accounts: GitHubAccount[] }>(`${base}/github/accounts`).then((result) => {
      if (result.data) {
        setAccounts(result.data.accounts);
        if (result.data.accounts.length === 1) setAccount(result.data.accounts[0]!.slug);
      } else setError(result.error ?? 'GitHub could not be read.');
    });
  }, [base, enabled]);

  return { accounts, account, setAccount, error };
}

/**
 * A repository host, browsed: Bitbucket's workspaces → projects →
 * repositories, or GitHub's accounts → repositories (no project layer)
 * — or a search by name across everything the person belongs to. Each
 * list is fetched as it is needed.
 */
function RepositoryBrowser({
  tenantId,
  provider,
  enabled,
  onChoose,
}: {
  tenantId: string;
  provider: RepoProvider;
  enabled: boolean;
  onChoose: (repo: RepoChoice) => void;
}) {
  const base = `/api/tenant/${tenantId}/code`;
  const isGitHub = provider === 'github';
  const bitbucket = useWorkspaceAndProject(base, enabled && !isGitHub);
  const github = useGitHubAccounts(base, enabled && isGitHub);
  const owner = isGitHub ? github.account : bitbucket.workspace;
  const browseError = isGitHub ? github.error : bitbucket.error;
  const [query, setQuery] = useState('');
  const repoAnchor = useCoachAnchor('code-repo-search');
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The repository list follows the owner (workspace/account), the
  // Bitbucket project and the search text; typing waits a beat so a fast
  // typist makes one request.
  useEffect(() => {
    if (!enabled) return;
    if (!owner && !query.trim()) {
      setRepos(null);
      return;
    }
    // A request the filters have moved past is dropped when it answers,
    // so a slow account-wide listing never overwrites a narrower one.
    let stale = false;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(null);
        const parts = isGitHub
          ? [
              owner ? `account=${encodeURIComponent(owner)}` : '',
              query.trim() ? `q=${encodeURIComponent(query.trim())}` : '',
            ]
          : [
              owner ? `workspace=${encodeURIComponent(owner)}` : '',
              bitbucket.project ? `project=${encodeURIComponent(bitbucket.project)}` : '',
              query.trim() ? `q=${encodeURIComponent(query.trim())}` : '',
            ];
        const path = isGitHub ? `${base}/github/repos` : `${base}/repos`;
        const listed = await getJson<{ repos: RepoChoice[] }>(
          `${path}?${parts.filter(Boolean).join('&')}`
        );
        if (stale) return;
        setLoading(false);
        if (listed.data) setRepos(listed.data.repos);
        else setError(listed.error ?? 'The repositories could not be read.');
      })();
    }, 250);
    return () => {
      stale = true;
    };
  }, [base, enabled, isGitHub, owner, bitbucket.project, query]);

  const hostLabel = isGitHub ? 'GitHub' : 'Bitbucket';

  return (
    <div className="space-y-2 rounded-md border border-gray-300 p-3 dark:border-gray-700">
      <div className={`grid gap-2 ${isGitHub ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">
            {isGitHub ? 'Account' : 'Workspace'}
          </span>
          <select
            value={owner}
            onChange={(event) =>
              isGitHub ? github.setAccount(event.target.value) : bitbucket.setWorkspace(event.target.value)
            }
            disabled={!enabled || (isGitHub ? github.accounts === null : bitbucket.workspaces === null)}
            className={inputClass}
          >
            <option value="">
              {(isGitHub ? github.accounts : bitbucket.workspaces) === null
                ? 'Loading…'
                : `All ${isGitHub ? 'accounts' : 'workspaces'}`}
            </option>
            {(isGitHub ? github.accounts : bitbucket.workspaces)?.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        {!isGitHub && (
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">Project</span>
            <select
              value={bitbucket.project}
              onChange={(event) => bitbucket.setProject(event.target.value)}
              disabled={!bitbucket.workspace || bitbucket.projects === null}
              className={inputClass}
            >
              <option value="">
                {!bitbucket.workspace
                  ? 'Pick a workspace'
                  : bitbucket.projects === null
                    ? 'Loading…'
                    : 'All projects'}
              </option>
              {(bitbucket.projects ?? []).map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Search by name</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="billing"
            {...repoAnchor}
            autoComplete="off"
            spellCheck={false}
            disabled={!enabled}
            className={inputClass}
          />
        </label>
      </div>
      {error || browseError ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error ?? browseError}
        </p>
      ) : null}
      {repos === null ? (
        <p className="text-xs text-gray-500">
          {loading
            ? `Searching ${hostLabel}…`
            : `Pick ${isGitHub ? 'an account' : 'a workspace'}, or search every one by name.`}
        </p>
      ) : repos.length === 0 ? (
        <p className="text-xs text-gray-500">
          {loading ? `Searching ${hostLabel}…` : 'No repositories match.'}
        </p>
      ) : (
        <ul
          aria-label="Repositories"
          className="max-h-64 divide-y divide-gray-200 overflow-y-auto rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800"
        >
          {repos.map((repo) => (
            <li key={repo.fullName}>
              <button
                type="button"
                onClick={() => onChoose(repo)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.branch} className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{repo.name}</span>
                  <span className="block truncate font-mono text-xs text-gray-500">
                    {repo.fullName}
                    {repo.projectKey ? ` · ${repo.projectKey}` : ''}
                    {repo.mainBranch ? ` · ${repo.mainBranch}` : ''}
                  </span>
                </span>
                <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A brand-new, empty repository: pick the workspace/project (Bitbucket)
 * or account (GitHub), give it a name, and create it — the resulting
 * repository is handed back exactly as one the browser would have
 * found, so the rest of the form (branch, .env, instructions) treats it
 * the same either way.
 */
function CreateRepository({
  tenantId,
  provider,
  enabled,
  onCreated,
}: {
  tenantId: string;
  provider: RepoProvider;
  enabled: boolean;
  onCreated: (repo: RepoChoice) => void;
}) {
  const base = `/api/tenant/${tenantId}/code`;
  const isGitHub = provider === 'github';
  const bitbucket = useWorkspaceAndProject(base, enabled && !isGitHub);
  const github = useGitHubAccounts(base, enabled && isGitHub);
  const owner = isGitHub ? github.account : bitbucket.workspace;
  const browseError = isGitHub ? github.error : bitbucket.error;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = repoSlugFromName(name);
  const canCreate = isGitHub ? Boolean(owner && slug) : Boolean(owner && bitbucket.project && slug);

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const result = isGitHub
      ? await sendJsonFull<{ repo: RepoChoice }>(`${base}/github/repos`, 'POST', {
          account: owner,
          name: name.trim(),
        })
      : await sendJsonFull<{ repo: RepoChoice }>(`${base}/bitbucket/repos`, 'POST', {
          workspace: owner,
          project: bitbucket.project,
          name: name.trim(),
        });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The repository could not be created.');
      return;
    }
    onCreated(result.data.repo);
  };

  return (
    <div className="space-y-2 rounded-md border border-gray-300 p-3 dark:border-gray-700">
      <div className={`grid gap-2 ${isGitHub ? '' : 'sm:grid-cols-2'}`}>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">
            {isGitHub ? 'Account' : 'Workspace'}
          </span>
          <select
            value={owner}
            onChange={(event) =>
              isGitHub ? github.setAccount(event.target.value) : bitbucket.setWorkspace(event.target.value)
            }
            disabled={!enabled || (isGitHub ? github.accounts === null : bitbucket.workspaces === null)}
            className={inputClass}
          >
            <option value="">
              {(isGitHub ? github.accounts : bitbucket.workspaces) === null
                ? 'Loading…'
                : `Pick ${isGitHub ? 'an account' : 'a workspace'}`}
            </option>
            {(isGitHub ? github.accounts : bitbucket.workspaces)?.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        {!isGitHub && (
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">Project</span>
            <select
              value={bitbucket.project}
              onChange={(event) => bitbucket.setProject(event.target.value)}
              disabled={!bitbucket.workspace || bitbucket.projects === null}
              className={inputClass}
            >
              <option value="">
                {!bitbucket.workspace
                  ? 'Pick a workspace first'
                  : bitbucket.projects === null
                    ? 'Loading…'
                    : 'Pick a project'}
              </option>
              {(bitbucket.projects ?? []).map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="block">
        <span className="mb-1 block text-xs text-gray-500">Repository name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          placeholder="billing-service"
          autoComplete="off"
          spellCheck={false}
          disabled={!enabled}
          className={`font-mono ${inputClass}`}
        />
        <span className="mt-1 block text-xs text-gray-500">
          {name.trim() && owner
            ? `Creates ${owner}/${slug || '…'} — empty and private.`
            : 'An empty, private repository — the first chat clones it once it has something to work with.'}
        </span>
      </label>
      {error || browseError ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error ?? browseError}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !enabled || !canCreate}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create repository'}
        </button>
      </div>
    </div>
  );
}
