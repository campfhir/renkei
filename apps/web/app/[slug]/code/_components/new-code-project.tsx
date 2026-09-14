'use client';

/**
 * The new-code-project form. The repository comes from the person's own
 * Bitbucket (a picker fed by their grant, or typed as workspace/repo);
 * the `.env` is pasted as a file's text and parsed on the server — only
 * the pairs reach the sandbox worker, which seals them, and nothing
 * here ever shows a value again. Lines that were not variables are
 * reported back after creation so a person knows what did not take.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getJson, sendJsonFull } from '@/lib/fetch-json';

interface RepoChoice {
  fullName: string;
  mainBranch: string | null;
}

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
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');
  const [env, setEnv] = useState('');
  const [instructions, setInstructions] = useState('');
  const [choices, setChoices] = useState<RepoChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (query: string) => {
    setRepository(query);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!bitbucketConnected) return;
    searchTimer.current = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const listed = await getJson<{ repos: RepoChoice[] }>(
          `/api/tenant/${tenantId}/code/repos?q=${encodeURIComponent(query.split('/').pop() ?? query)}`
        );
        setSearching(false);
        if (listed.data) setChoices(listed.data.repos.slice(0, 12));
      })();
    }, 300);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ projectId: string; envProblems: string[] }>(
      `/api/tenant/${tenantId}/code/projects`,
      'POST',
      {
        name: name.trim(),
        repository: repository.trim(),
        branch: branch.trim(),
        env,
        instructions: instructions.trim() || null,
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

  const chosen = choices.find((choice) => choice.fullName === repository);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
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
            . A code project clones with your own Bitbucket access.
          </p>
        ) : null}

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            required
            className={inputClass}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-gray-500">Repository</span>
            <input
              value={repository}
              onChange={(event) => search(event.target.value)}
              placeholder="workspace/repo-slug"
              autoComplete="off"
              spellCheck={false}
              required
              list="code-project-repos"
              className={`font-mono ${inputClass}`}
            />
            <datalist id="code-project-repos">
              {choices.map((choice) => (
                <option key={choice.fullName} value={choice.fullName} />
              ))}
            </datalist>
            <span className="mt-1 block text-xs text-gray-500">
              {searching ? 'Searching Bitbucket…' : 'Type to search your Bitbucket repositories.'}
            </span>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-gray-500">Branch</span>
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder={chosen?.mainBranch ?? 'main branch'}
              autoComplete="off"
              spellCheck={false}
              className={`font-mono ${inputClass}`}
            />
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            .env — the environment the project’s commands run with (optional)
          </span>
          <textarea
            value={env}
            onChange={(event) => setEnv(event.target.value)}
            rows={8}
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
            Instructions — what every chat in this project should know (optional)
          </span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            maxLength={20_000}
            placeholder="How to run the tests, the conventions to keep, what not to touch…"
            className={inputClass}
          />
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
            disabled={
              busy || !bitbucketConnected || !name.trim() || !repository.trim().includes('/')
            }
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create and clone'}
          </button>
        </div>
      </form>
    </div>
  );
}
