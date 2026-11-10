'use client';

import { useReducer } from 'react';
import Link from 'next/link';
import { Icon, ICONS } from '@/components/icons';
import type { ProjectListItem } from '@/lib/chat/sidebar';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import {
  codeIndexReducer,
  emptyKind,
  initialCodeIndex,
  projectsPage,
  type CodeIndexAction,
  type CodeIndexState,
} from './code-index.model';

export default function CodeIndex({ projects, enabled, canCreate, accessNotice }: {
  projects: ProjectListItem[];
  /** The deployment runs code workspaces; without them nothing here can be made. */
  enabled: boolean;
  /** This person's Bitbucket or GitHub connection carries what a project runs on (lib/code/access.ts). */
  canCreate: boolean;
  /** When it does not: what to connect, said the Connectors page's way. */
  accessNotice: string | null;
}) {
  const mine = projects.filter((project) => project.role === 'owner');
  const shared = projects.filter((project) => project.role !== 'owner');

  const [state, dispatch] = useReducer(codeIndexReducer, initialCodeIndex);
  const newAnchor = useCoachAnchor('code-new');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <h1 className="flex-1 text-sm font-semibold">Code</h1>
        {enabled && canCreate ? (
          <Link
            href={`/code/new`}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            {...newAnchor}
          >
            New code project
          </Link>
        ) : null}
      </header>
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          A code project is a repository from Bitbucket or GitHub, cloned into the sandbox, with the
          environment its commands need. Chats inside it can read and change the code, run the
          project’s own tests and builds, commit, and push a branch for a pull request — with Jira
          and your other connectors beside them.
        </p>
        {!enabled ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            Code workspaces are not enabled for this organization. An operator turns them on under
            Settings → Sandbox.
          </p>
        ) : !canCreate && accessNotice ? (
          <p
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {accessNotice}{' '}
            <Link href={`/connectors`} className="underline">
              Open Connectors
            </Link>
            . A code project clones, pushes and opens pull requests with your own access on the
            repository’s host.
          </p>
        ) : null}
        {projects.length > 0 ? (
          <input
            type="search"
            value={state.query}
            onChange={(event) => dispatch({ type: 'query', value: event.target.value })}
            placeholder="Search projects by name, repository, description or owner"
            aria-label="Search code projects"
            className="w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 text-sm dark:border-gray-700"
          />
        ) : null}
        <Group
          title="Mine"
          group="mine"
          projects={mine}
          state={state}
          dispatch={dispatch}
          empty="You have no code projects yet."
        />
        <Group
          title="Shared with me"
          group="shared"
          projects={shared}
          state={state}
          dispatch={dispatch}
          empty="Nothing has been shared with you."
        />
      </div>
    </div>
  );
}

function Group({ title, group, projects, state, dispatch, empty }: {
  title: string;
  group: 'mine' | 'shared';
  projects: ProjectListItem[];
  state: CodeIndexState;
  dispatch: (action: CodeIndexAction) => void;
  empty: string;
}) {
  const shown = projectsPage(projects, state, group);
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">{title}</h2>
      {shown.total === 0 ? (
        <p className="text-sm text-gray-500">
          {emptyKind(projects, state.query) === 'none' ? empty : 'No projects match your search.'}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {shown.items.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/code/${project.id}`}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.code} className="h-5 w-5 shrink-0 text-gray-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{project.name}</span>
                    <span className="block truncate font-mono text-xs text-gray-500">
                      {project.repoFullName ?? ''}
                      {project.ownerName ? ` · shared by ${project.ownerName}` : ''}
                    </span>
                    {project.description ? (
                      <span className="line-clamp-2 text-xs text-gray-600 dark:text-gray-400">
                        {project.description}
                      </span>
                    ) : null}
                  </span>
                  <Icon path={ICONS.chevron} className="h-4 w-4 text-gray-400" />
                </Link>
              </li>
            ))}
          </ul>
          {shown.pageCount > 1 && shown.range ? (
            <nav
              aria-label={`${title} pages`}
              className="mt-2 flex items-center justify-between text-xs text-gray-500"
            >
              <span>
                {shown.range[0]}–{shown.range[1]} of {shown.total}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={shown.page === 0}
                  onClick={() => dispatch({ type: 'page', group, page: shown.page - 1 })}
                  className="rounded-md border border-gray-300 px-2 py-1 disabled:opacity-40 dark:border-gray-700"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={shown.page >= shown.pageCount - 1}
                  onClick={() => dispatch({ type: 'page', group, page: shown.page + 1 })}
                  className="rounded-md border border-gray-300 px-2 py-1 disabled:opacity-40 dark:border-gray-700"
                >
                  Next
                </button>
              </span>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
