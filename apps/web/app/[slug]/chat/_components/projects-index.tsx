'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';
import type { ProjectListItem } from '@/lib/chat/sidebar';
import { DialogFooter } from './chat-nav';

export default function ProjectsIndex({
  slug,
  tenantId,
  projects,
  openNew,
}: {
  slug: string;
  tenantId: string;
  projects: ProjectListItem[];
  openNew: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(openNew);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ projectId: string }>(
      `/api/tenant/${tenantId}/chat/projects`,
      'POST',
      { name: name.trim(), description: description.trim() || null }
    );
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The project could not be created.');
      return;
    }
    router.push(`/${slug}/chat/projects/${result.data.projectId}`);
    router.refresh();
  };

  const mine = projects.filter((project) => project.role === 'owner');
  const shared = projects.filter((project) => project.role !== 'owner');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <h1 className="flex-1 text-sm font-semibold">Projects</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New project
        </button>
      </header>
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          A project is a shared workspace: instructions, files and memory that every chat inside it
          reads. Share one with colleagues and each of you chats with the same context.
        </p>
        <ProjectGroup slug={slug} title="Mine" projects={mine} empty="You have no projects yet." />
        <ProjectGroup
          slug={slug}
          title="Shared with me"
          projects={shared}
          empty="Nothing has been shared with you."
        />
      </div>
      {creating ? (
        <Modal title="New project" onClose={() => setCreating(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
            className="space-y-3"
          >
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-500">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                required
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-500">
                Description (optional)
              </span>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
              />
            </label>
            <DialogFooter
              busy={busy}
              error={error}
              label="Create"
              onCancel={() => setCreating(false)}
            />
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function ProjectGroup({
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
                href={`/${slug}/chat/projects/${project.id}`}
                className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.folder} className="h-5 w-5 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{project.name}</span>
                  {project.ownerName ? (
                    <span className="block text-xs text-gray-500">
                      Shared by {project.ownerName}
                    </span>
                  ) : null}
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
