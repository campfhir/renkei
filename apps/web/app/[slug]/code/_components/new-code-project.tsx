'use client';

/**
 * The new-code-project form. The repository is picked from the person's
 * own Bitbucket — browsed workspace → project → repositories, searched by
 * name across everything they belong to, or created fresh (empty) under a
 * chosen workspace and project — never typed by hand for an existing repo;
 * the `.env` is pasted as a file's text and parsed on the server (only the
 * pairs reach the sandbox worker, which seals them, and nothing here shows
 * a value again); the instructions start from a developer's brief. Nothing
 * is cloned yet: the first chat in the project does that.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { DEFAULT_CODE_INSTRUCTIONS } from '@/lib/code/default-instructions';
import { repoSlugFromName } from '@/lib/code/repo-slug';
import type { BrowseProject, BrowseWorkspace, RepoChoice } from '@/lib/code/bitbucket-browse';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function NewCodeProject({
  slug,
  tenantId,
  bitbucketConnected,
}: {
  slug: string;
  tenantId: string;
  bitbucketConnected: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [repoMode, setRepoMode] = useState<'choose' | 'create'>('choose');
  const [chosen, setChosen] = useState<RepoChoice | null>(null);
  const [branch, setBranch] = useState('');
  const [env, setEnv] = useState('');
  const [instructions, setInstructions] = useState(DEFAULT_CODE_INSTRUCTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ projectId: string; envProblems: string[] }>(
      `/api/tenant/${tenantId}/code/projects`,
      'POST',
      {
        name: name.trim() || chosen.name,
        repository: chosen.fullName,
        branch: branch.trim(),
        env,
        instructions: instructions.trim(),
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
        {!bitbucketConnected ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            Connect Bitbucket first —{' '}
            <Link href={`/${slug}/connectors`} className="underline">
              on the Connectors page
            </Link>
            . A code project reads and clones its repository with your own Bitbucket access.
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
                  tenantId={tenantId}
                  enabled={bitbucketConnected}
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
                  tenantId={tenantId}
                  enabled={bitbucketConnected}
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
          />
          <span className="mt-1 block text-xs text-gray-500">
            A developer’s standing brief to start from — change it here or on the project’s page
            later; add how this repository runs its tests, the conventions to keep, what not to
            touch.
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
            disabled={busy || !bitbucketConnected || !chosen}
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
 * Bitbucket, browsed: the workspaces the person belongs to, a workspace's
 * projects, and the repositories under the chosen one — or a search by
 * name across every workspace. Each list is fetched as it is needed.
 */
function RepositoryBrowser({
  tenantId,
  enabled,
  onChoose,
}: {
  tenantId: string;
  enabled: boolean;
  onChoose: (repo: RepoChoice) => void;
}) {
  const base = `/api/tenant/${tenantId}/code`;
  const {
    workspaces,
    workspace,
    setWorkspace,
    projects,
    project,
    setProject,
    error: browseError,
  } = useWorkspaceAndProject(base, enabled);
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The repository list follows the workspace, the project and the search
  // text; typing waits a beat so a fast typist makes one request.
  useEffect(() => {
    if (!enabled) return;
    if (!workspace && !query.trim()) {
      setRepos(null);
      return;
    }
    // A request the filters have moved past is dropped when it answers,
    // so a slow workspace-wide listing never overwrites a narrower one.
    let stale = false;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(null);
        const parts = [
          workspace ? `workspace=${encodeURIComponent(workspace)}` : '',
          project ? `project=${encodeURIComponent(project)}` : '',
          query.trim() ? `q=${encodeURIComponent(query.trim())}` : '',
        ].filter(Boolean);
        const listed = await getJson<{ repos: RepoChoice[] }>(`${base}/repos?${parts.join('&')}`);
        if (stale) return;
        setLoading(false);
        if (listed.data) setRepos(listed.data.repos);
        else setError(listed.error ?? 'The repositories could not be read.');
      })();
    }, 250);
    return () => {
      stale = true;
    };
  }, [base, enabled, workspace, project, query]);

  return (
    <div className="space-y-2 rounded-md border border-gray-300 p-3 dark:border-gray-700">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Workspace</span>
          <select
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            disabled={!enabled || workspaces === null}
            className={inputClass}
          >
            <option value="">{workspaces === null ? 'Loading…' : 'All workspaces'}</option>
            {(workspaces ?? []).map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Project</span>
          <select
            value={project}
            onChange={(event) => setProject(event.target.value)}
            disabled={!workspace || projects === null}
            className={inputClass}
          >
            <option value="">
              {!workspace ? 'Pick a workspace' : projects === null ? 'Loading…' : 'All projects'}
            </option>
            {(projects ?? []).map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Search by name</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="billing"
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
          {loading ? 'Searching Bitbucket…' : 'Pick a workspace, or search every one by name.'}
        </p>
      ) : repos.length === 0 ? (
        <p className="text-xs text-gray-500">
          {loading ? 'Searching Bitbucket…' : 'No repositories match.'}
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
 * A brand-new, empty Bitbucket repository: pick the workspace and the
 * project it belongs to, give it a name, and create it — the resulting
 * repository is handed back exactly as one the browser would have found,
 * so the rest of the form (branch, .env, instructions) treats it the
 * same either way.
 */
function CreateRepository({
  tenantId,
  enabled,
  onCreated,
}: {
  tenantId: string;
  enabled: boolean;
  onCreated: (repo: RepoChoice) => void;
}) {
  const base = `/api/tenant/${tenantId}/code`;
  const {
    workspaces,
    workspace,
    setWorkspace,
    projects,
    project,
    setProject,
    error: browseError,
  } = useWorkspaceAndProject(base, enabled);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = repoSlugFromName(name);

  const create = async () => {
    if (!workspace || !project || !slug) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ repo: RepoChoice }>(`${base}/bitbucket/repos`, 'POST', {
      workspace,
      project,
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
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Workspace</span>
          <select
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            disabled={!enabled || workspaces === null}
            className={inputClass}
          >
            <option value="">{workspaces === null ? 'Loading…' : 'Pick a workspace'}</option>
            {(workspaces ?? []).map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Project</span>
          <select
            value={project}
            onChange={(event) => setProject(event.target.value)}
            disabled={!workspace || projects === null}
            className={inputClass}
          >
            <option value="">
              {!workspace ? 'Pick a workspace first' : projects === null ? 'Loading…' : 'Pick a project'}
            </option>
            {(projects ?? []).map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
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
          {name.trim() && workspace
            ? `Creates ${workspace}/${slug || '…'} — empty and private.`
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
          disabled={busy || !enabled || !workspace || !project || !slug}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create repository'}
        </button>
      </div>
    </div>
  );
}
