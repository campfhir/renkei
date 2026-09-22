'use client';

import Link from 'next/link';
import { Icon, ICONS } from '@/components/icons';
import type { ProjectListItem } from '@/lib/chat/sidebar';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

export default function CodeIndex({
  slug,
  projects,
  enabled,
  canCreate,
  accessNotice,
}: {
  slug: string;
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

  const newAnchor = useCoachAnchor('code-new');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <h1 className="flex-1 text-sm font-semibold">Code</h1>
        {enabled && canCreate ? (
          <Link
            href={`/${slug}/code/new`}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            {...newAnchor}
          >
            New code project
          </Link>
        ) : null}
      </header>
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          A code project is a repository from Bitbucket or GitHub, cloned into the sandbox, with
          the environment its commands need. Chats inside it can read and change the code, run the
          project’s own tests and builds, commit, and push a branch for a pull request — with Jira
          and your other connectors beside them.
        </p>
        {!enabled ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            Code workspaces are not enabled on this deployment. An operator turns them on with
            SANDBOX_WORKSPACES_ENABLED on the web app and the sandbox worker.
          </p>
        ) : !canCreate && accessNotice ? (
          <p
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {accessNotice}{' '}
            <Link href={`/${slug}/connectors`} className="underline">
              Open Connectors
            </Link>
            . A code project clones, pushes and opens pull requests with your own access on the
            repository’s host.
          </p>
        ) : null}
        <Group slug={slug} title="Mine" projects={mine} empty="You have no code projects yet." />
        <Group
          slug={slug}
          title="Shared with me"
          projects={shared}
          empty="Nothing has been shared with you."
        />
      </div>
    </div>
  );
}

function Group({
  slug,
  title,
  projects,
  empty,
}: {
  slug: string;
  title: string;
  projects: ProjectListItem[];
  empty: string;
}) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">{title}</h2>
      {projects.length === 0 ? (
        <p className="text-sm text-gray-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`/${slug}/code/${project.id}`}
                className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.code} className="h-5 w-5 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{project.name}</span>
                  <span className="block truncate font-mono text-xs text-gray-500">
                    {project.repoFullName ?? ''}
                    {project.ownerName ? ` · shared by ${project.ownerName}` : ''}
                  </span>
                </span>
                <Icon path={ICONS.chevron} className="h-4 w-4 text-gray-400" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
