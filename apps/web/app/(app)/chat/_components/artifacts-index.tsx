'use client';

/**
 * The Artifacts page: everything this person owns — uploads and the
 * files their chats generated — and everything shared with them, each
 * with where it is used; the whole page a drop target; one selected at a
 * time, with its details and acts beside the list. What the viewer may
 * do follows artifact-access.ts: an owner renames, replaces, shares,
 * hands over or deletes; a person it was shared with uses it, copies it
 * or takes it off their own list.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import DownloadLink from '@/components/download-link';
import LocalTime from '@/components/local-time';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import ShareModal from './share-modal';
import AttachArtifactsPicker from './attach-to-project-modal';
import { CopyArtifactModal, DeleteArtifactModal, RenameArtifactModal } from './artifact-dialogs';
import { ModeToggle, sizeOf, statusLabel, TypeBadge } from './artifact-bits';

type Show = 'all' | 'uploaded' | 'generated' | 'shared';

export default function ArtifactsIndex({
  initial,
  uploads,
  projects,
  selectedId,
}: {
  initial: LibraryItem[];
  uploads: boolean;
  projects: { id: string; name: string; kind: string }[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  useEffect(() => setItems(initial), [initial]);
  const [show, setShow] = useState<Show>('all');
  const [projectFilter, setProjectFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(selectedId);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    'share' | 'delete' | 'copy' | 'rename' | 'attach' | 'replace' | null
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const reload = useCallback(async () => {
    const result = await chatClient.artifacts();
    if (result.data) setItems(result.data.artifacts);
    router.refresh();
  }, [router]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (show === 'shared' && item.via === 'owner') return false;
      if (show === 'uploaded' && (item.via !== 'owner' || item.origin !== 'upload')) return false;
      if (show === 'generated' && (item.via !== 'owner' || item.origin !== 'model')) return false;
      if (projectFilter && !item.projects.some((project) => project.id === projectFilter))
        return false;
      return !needle || item.filename.toLowerCase().includes(needle);
    });
  }, [items, show, projectFilter, query]);

  const current = items.find((item) => item.id === selected) ?? null;
  const totalBytes = items
    .filter((item) => item.via === 'owner')
    .reduce((sum, item) => sum + item.sizeBytes, 0);

  const upload = async (list: FileList | File[] | null) => {
    const files = list ? [...list] : [];
    if (files.length === 0) return;
    setError(null);
    setUploading(files.length);
    let last: string | null = null;
    for (const file of files) {
      const result = await chatClient.uploadArtifact({}, file);
      if (result.error) setError(`${file.name}: ${result.error}`);
      else last = result.data?.id ?? null;
      setUploading((count) => count - 1);
    }
    await reload();
    if (last) setSelected(last);
  };

  const replace = async (file: File | null) => {
    if (!file || !current) return;
    setError(null);
    const result = await chatClient.replaceArtifact(current.id, file);
    if (result.error) setError(result.error);
    await reload();
  };

  const setMode = async (item: LibraryItem, projectId: string, mode: 'always' | 'on_demand') => {
    setError(null);
    const result = await chatClient.setArtifactMode(projectId, item.id, mode);
    if (result.error) setError(result.error);
    await reload();
  };

  const detach = async (item: LibraryItem, projectId: string) => {
    setError(null);
    const result = await chatClient.detachArtifact(projectId, item.id);
    if (result.error) setError(result.error);
    await reload();
  };

  const leave = async (item: LibraryItem) => {
    setError(null);
    const result = await chatClient.deleteArtifact(item.id);
    if (result.error) setError(result.error);
    setSelected(null);
    await reload();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (uploads && event.dataTransfer.files?.length) void upload(event.dataTransfer.files);
  };

  const tab = (value: Show, label: string) => (
    <button
      type="button"
      onClick={() => setShow(value)}
      className={`flex h-7 items-center rounded-md px-2.5 text-xs font-medium ${
        show === value
          ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-950 dark:text-gray-100'
          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="relative min-h-0 flex-1 overflow-y-auto"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        if (uploads) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <h1 className="flex-1 text-sm font-semibold">Artifacts</h1>
        {uploads ? (
          <>
            <button
              type="button"
              disabled={uploading > 0}
              onClick={() => fileInput.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Icon path={ICONS.upload} className="h-4 w-4" />
              {uploading > 0 ? `Uploading ${uploading}…` : 'Upload'}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              aria-label="Upload artifacts"
              onChange={(event) => {
                void upload(event.target.files);
                event.target.value = '';
              }}
            />
          </>
        ) : null}
      </header>

      <div className="mx-auto max-w-5xl space-y-3 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Files you upload and files chats generate: manuals, design docs, style guides, reports.
          Stored once, under you, outside every repository; a project holds one by reference, so the
          same file serves any number of projects.
          {!uploads
            ? ' File storage is not set up for this organization, so nothing can be uploaded yet.'
            : ''}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names…"
            aria-label="Search artifacts by name"
            className="w-64 max-w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div
            className="flex shrink-0 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
            role="group"
            aria-label="Show"
          >
            {tab('all', 'All')}
            {tab('uploaded', 'Uploaded')}
            {tab('generated', 'Generated')}
            {tab('shared', 'Shared with me')}
          </div>
          {projects.length > 0 ? (
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              aria-label="Used in project"
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="">Any project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
          <span className="ml-auto text-xs text-gray-500">
            {items.filter((item) => item.via === 'owner').length} of yours · {sizeOf(totalBytes)}
          </span>
        </div>

        <div className="flex flex-wrap items-start gap-4">
          <section
            aria-label="Artifacts"
            className="min-w-0 flex-[999_1_480px] rounded-lg border border-gray-200 dark:border-gray-800"
          >
            {shown.length === 0 ? (
              <p className="p-4 text-sm text-gray-500">
                {items.length === 0
                  ? 'No artifacts yet. Upload a manual, a guide or a design doc, or drop one anywhere on this page; files your chats write land here on their own.'
                  : 'Nothing matches.'}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-900">
                {shown.map((item) => {
                  const status = statusLabel(item.extractStatus);
                  const isSelected = item.id === selected;
                  return (
                    <li key={item.id} data-artifact={item.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(isSelected ? null : item.id)}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-900 ${isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}
                      >
                        <TypeBadge filename={item.filename} contentType={item.contentType} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.filename}</span>
                          <span className="block truncate text-xs text-gray-500">
                            {sizeOf(item.sizeBytes)}
                            {status ? (
                              <>
                                {' · '}
                                <span className="text-amber-700 dark:text-amber-400">{status}</span>
                              </>
                            ) : null}
                            {item.origin === 'model'
                              ? ' · generated'
                              : item.chat
                                ? ' · uploaded'
                                : ''}
                            {item.chat ? ` in “${item.chat.title ?? 'a chat'}”` : ''}
                            {item.ownerName ? ` · shared by ${item.ownerName}` : ''}
                            {' · '}
                            <LocalTime at={item.createdAt} format="date" />
                          </span>
                        </span>
                        <span className="hidden min-w-0 max-w-[14rem] shrink-0 flex-wrap justify-end gap-1 sm:flex">
                          {item.projects.length === 0 ? (
                            item.chat ? (
                              <span
                                className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
                                title={`In the chat “${item.chat.title ?? 'Untitled'}” only`}
                              >
                                <Icon path={ICONS.chat} className="h-3 w-3 shrink-0" />
                                <span className="truncate">{item.chat.title ?? 'a chat'}</span>
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">Not attached</span>
                            )
                          ) : (
                            item.projects.slice(0, 2).map((project) => (
                              <span
                                key={project.id}
                                className="truncate rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900"
                              >
                                {project.name}
                              </span>
                            ))
                          )}
                          {item.projects.length > 2 ? (
                            <span className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900">
                              +{item.projects.length - 2}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {uploads ? (
              <div className="flex items-center justify-center gap-2 border-t border-dashed border-gray-300 px-3 py-2.5 text-xs text-gray-500 dark:border-gray-700">
                <Icon path={ICONS.upload} className="h-3.5 w-3.5" />
                Drop files anywhere on this page to add them · any type
              </div>
            ) : null}
          </section>

          {current ? (
            <aside
              aria-label="Selected artifact"
              className="w-full min-w-[280px] flex-[1_1_300px] rounded-lg border border-gray-200 sm:max-w-[340px] dark:border-gray-800"
            >
              <div className="flex items-start gap-3 p-4">
                <TypeBadge filename={current.filename} contentType={current.contentType} large />
                <div className="min-w-0 flex-1">
                  <DownloadLink
                    href={chatClient.attachmentUrl(current.id)}
                    filename={current.filename}
                    className="block font-semibold break-words hover:underline"
                  >
                    {current.filename}
                  </DownloadLink>
                  <p className="text-xs text-gray-500">
                    {sizeOf(current.sizeBytes)} ·{' '}
                    {current.origin === 'model' ? 'generated' : 'uploaded'}{' '}
                    <LocalTime at={current.createdAt} format="date" /> ·{' '}
                    {current.via === 'owner'
                      ? 'owned by you'
                      : `${current.ownerName ?? 'someone'}’s`}
                  </p>
                  <p className="mt-1 text-xs">
                    {statusLabel(current.extractStatus) ? (
                      <span className="text-amber-700 dark:text-amber-400">
                        {statusLabel(current.extractStatus)}
                      </span>
                    ) : (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                        Ready to read
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Close details"
                  className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.close} className="h-4 w-4" />
                </button>
              </div>

              <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
                <h3 className="mb-2 text-xs font-semibold text-gray-500">Used in</h3>
                {current.projects.length === 0 ? (
                  <p className="text-xs text-gray-500">
                    {current.chat
                      ? 'In its chat only; it goes when the chat does unless a project takes it.'
                      : 'Not attached to a project.'}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {current.projects.map((project) => (
                      <li key={project.id} className="flex items-center gap-2 text-sm">
                        <Icon
                          path={project.kind === 'code' ? ICONS.code : ICONS.pages}
                          className="h-3.5 w-3.5 shrink-0 text-gray-400"
                        />
                        <Link
                          href={
                            project.kind === 'code'
                              ? `/code/${project.id}`
                              : `/chat/projects/${project.id}`
                          }
                          className="min-w-0 flex-1 truncate hover:underline"
                        >
                          {project.name}
                        </Link>
                        <ModeToggle
                          label={`How ${project.name} uses ${current.filename}`}
                          value={project.mode}
                          onChange={(mode) => void setMode(current, project.id, mode)}
                        />
                        <button
                          type="button"
                          onClick={() => void detach(current, project.id)}
                          aria-label={`Detach from ${project.name}`}
                          className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-900"
                        >
                          <Icon path={ICONS.close} className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {current.chat ? (
                  <p className="mt-2 text-xs text-gray-500">
                    From the chat{' '}
                    <Link href={`/chat/${current.chat.id}`} className="hover:underline">
                      {current.chat.title ?? 'Untitled'}
                    </Link>
                  </p>
                ) : null}
                {projects.length > 0 && (current.via === 'owner' || current.via === 'grant') ? (
                  <button
                    type="button"
                    onClick={() => setDialog('attach')}
                    className="mt-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    + Attach to a project…
                  </button>
                ) : null}
              </div>

              <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
                <h3 className="mb-2 text-xs font-semibold text-gray-500">Access</h3>
                <p className="text-xs text-gray-500">
                  {current.via === 'owner'
                    ? `You own it${current.sharedWith > 0 ? `; shared with ${current.sharedWith} ${current.sharedWith === 1 ? 'person' : 'people'}` : ''}. ${current.projects.length > 0 ? 'Everyone in the projects above reads it; their owners and editors may detach it.' : ''}`
                    : current.via === 'grant'
                      ? 'Shared with you: use it in your own projects, read it, copy it. Only its owner changes it.'
                      : 'You read it through a project or chat it is used in.'}
                </p>
                {current.via === 'owner' ? (
                  <button
                    type="button"
                    onClick={() => setDialog('share')}
                    className="mt-2 inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                  >
                    <Icon path={ICONS.share} className="h-3.5 w-3.5" />
                    Share…
                  </button>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-3 dark:border-gray-900">
                <DownloadLink
                  href={chatClient.attachmentUrl(current.id)}
                  filename={current.filename}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.download} className="h-3.5 w-3.5" />
                  Download
                </DownloadLink>
                {current.via === 'owner' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => replaceInput.current?.click()}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                    >
                      Replace file…
                    </button>
                    <input
                      ref={replaceInput}
                      type="file"
                      className="hidden"
                      aria-label="Replace the file"
                      onChange={(event) => {
                        void replace(event.target.files?.[0] ?? null);
                        event.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setDialog('rename')}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => setDialog('delete')}
                      className="ml-auto text-xs text-red-600 hover:underline dark:text-red-400"
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setDialog('copy')}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                    >
                      <Icon path={ICONS.copy} className="h-3.5 w-3.5" />
                      Make a copy I own
                    </button>
                    {current.via === 'grant' ? (
                      <button
                        type="button"
                        onClick={() => void leave(current)}
                        className="ml-auto text-xs text-red-600 hover:underline dark:text-red-400"
                        title={`Keeps ${current.ownerName ?? 'the owner'}’s file`}
                      >
                        Remove from my artifacts
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              <p className="px-4 pb-3 text-xs text-gray-500">
                {current.via === 'owner'
                  ? 'Replacing keeps every attachment and re-reads the text. Deleting shows who loses it and offers to hand it over instead.'
                  : 'A copy is a separate file you own; the owner is told. Removing it keeps their file and their shares.'}
              </p>
            </aside>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </div>

      {dragging && uploads ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-blue-500 bg-blue-50/95 text-blue-700 dark:bg-blue-950/90 dark:text-blue-300">
          <Icon path={ICONS.upload} className="h-8 w-8" />
          <p className="text-lg font-semibold">Drop to add to your artifacts</p>
          <p className="text-sm">PDF, Office, images, code, text — anything goes</p>
        </div>
      ) : null}

      {dialog === 'share' && current ? (
        <ShareModal
          kind="artifact"
          resourceId={current.id}
          title={`Share ${current.filename}`}
          onClose={() => {
            setDialog(null);
            void reload();
          }}
        />
      ) : null}
      {dialog === 'delete' && current ? (
        <DeleteArtifactModal
          item={current}
          onDone={() => {
            setSelected(null);
            void reload();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'copy' && current ? (
        <CopyArtifactModal
          item={current}
          projects={projects}
          onDone={(artifactId) => {
            setSelected(artifactId);
            void reload();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'rename' && current ? (
        <RenameArtifactModal
          item={current}
          onDone={() => void reload()}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'attach' && current ? (
        <AttachArtifactsPicker
          item={current}
          projects={projects}
          onDone={() => void reload()}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
