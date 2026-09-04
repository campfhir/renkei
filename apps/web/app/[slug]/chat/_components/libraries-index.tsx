'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';
import { DialogFooter } from './chat-nav';

export interface LibraryListItem {
  id: string;
  name: string;
  description: string | null;
  publishedToOrg: boolean;
  role: 'owner' | 'editor' | 'viewer';
}

export default function LibrariesIndex({
  slug,
  tenantId,
  libraries,
}: {
  slug: string;
  tenantId: string;
  libraries: LibraryListItem[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ libraryId: string }>(
      `/api/tenant/${tenantId}/chat/prompt-libraries`,
      'POST',
      { name: name.trim(), description: description.trim() || null }
    );
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The library could not be created.');
      return;
    }
    router.push(`/${slug}/chat/prompts/${result.data.libraryId}`);
    router.refresh();
  };

  const mine = libraries.filter((library) => library.role === 'owner');
  const others = libraries.filter((library) => library.role !== 'owner');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <h1 className="flex-1 text-sm font-semibold">Prompt libraries</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New library
        </button>
      </header>
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          A library holds prompts you reuse. Insert one from the composer with the sparkle button or
          by typing <kbd className="rounded border px-1">/</kbd>. Share a library with colleagues,
          or publish it to the whole organization.
        </p>
        <Group slug={slug} title="Mine" libraries={mine} empty="You have no libraries yet." />
        <Group
          slug={slug}
          title="Shared and published"
          libraries={others}
          empty="Nothing has been shared with you."
        />
      </div>
      {creating ? (
        <Modal title="New library" onClose={() => setCreating(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
            className="space-y-3"
          >
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              maxLength={200}
              required
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Description (optional)"
              maxLength={2000}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
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

function Group({
  slug,
  title,
  libraries,
  empty,
}: {
  slug: string;
  title: string;
  libraries: LibraryListItem[];
  empty: string;
}) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">{title}</h2>
      {libraries.length === 0 ? (
        <p className="text-sm text-gray-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {libraries.map((library) => (
            <li key={library.id}>
              <Link
                href={`/${slug}/chat/prompts/${library.id}`}
                className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.sparkle} className="h-5 w-5 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{library.name}</span>
                  {library.description ? (
                    <span className="block truncate text-xs text-gray-500">
                      {library.description}
                    </span>
                  ) : null}
                </span>
                {library.publishedToOrg ? (
                  <span className="text-[10px] text-gray-400 uppercase">org</span>
                ) : null}
                <Icon path={ICONS.chevron} className="h-4 w-4 text-gray-400" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
