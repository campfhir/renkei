'use client';

/**
 * A project's page: instructions (editors), files (editors upload, all
 * download), memory (editors add and remove), the toolset chats inherit,
 * the chats inside it, and sharing (owner). Every change goes through a
 * route and refreshes the server data. On a code project the chats come
 * right after the repository and environment — what a developer opens
 * the page for — and the README folds beneath them.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '@/lib/use-media-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';
import { chatClient } from '@/lib/chat/client';
import type { ProjectView as ProjectViewData } from '@/lib/chat/project-view';
import { DialogFooter } from './chat-nav';
import AttachmentChip from './attachment-chip';
import ShareModal from './share-modal';
import ToolsPopover from './tools-popover';
import { CODE_PROJECT_CONNECTORS } from '@/lib/chat/tool-config';
import Markdown from './markdown';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function ProjectView({
  slug,
  tenantId,
  initial,
  variant = 'chat',
  before = null,
  aside = null,
  defaultInstructions = null,
  readme = null,
}: {
  slug: string;
  tenantId: string;
  initial: ProjectViewData;
  /**
   * A code project is a chat project with a repository on it: the same
   * page, listed under Code, deleted through the code route (which takes
   * the checkout and the environment with it), and headed by the
   * repository and environment sections the caller passes in `before`.
   */
  variant?: 'chat' | 'code';
  before?: ReactNode;
  /**
   * A second column on a wide screen, to the left of the sections — a
   * code project's repository tree; folded above them on a narrow one.
   */
  aside?: ReactNode;
  /**
   * What the instructions field starts as when the project has none —
   * shown so it can be read and changed, kept the moment Save is pressed.
   */
  defaultInstructions?: string | null;
  /**
   * A code project's README, rendered in place of a typed description —
   * the repository describes itself.
   */
  readme?: { path: string; text: string } | null;
}) {
  const router = useRouter();
  const { project, role, files, memory, chats } = initial;
  const canEdit = role !== 'viewer';
  const base = `/api/tenant/${tenantId}/chat/projects/${project.id}`;
  const indexHref = variant === 'code' ? `/${slug}/code` : `/${slug}/chat/projects`;
  const deleteRoute =
    variant === 'code' ? `/api/tenant/${tenantId}/code/projects/${project.id}` : base;

  const [name, setName] = useState(project.name);
  const [renamingHeader, setRenamingHeader] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState(project.description ?? '');
  const [instructions, setInstructions] = useState(
    project.instructions ?? defaultInstructions ?? ''
  );
  // Wide first: the column layout is the usual one, and a phone flips.
  const wide = useMediaQuery('(min-width: 1024px)', true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [share, setShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty =
    name !== project.name ||
    description !== (project.description ?? '') ||
    instructions !== (project.instructions ?? '');

  useEffect(() => {
    if (renamingHeader) nameInputRef.current?.select();
  }, [renamingHeader]);

  const startRenaming = () => {
    if (!canEdit) return;
    setName(project.name);
    setRenamingHeader(true);
  };

  // The header's own quick rename: it saves just the name, immediately,
  // separately from the About section's Save (which also carries
  // description and instructions).
  const renameFromHeader = async () => {
    const next = name.trim();
    if (!next || next === project.name) {
      setName(project.name);
      setRenamingHeader(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await sendJsonFull(base, 'PATCH', { name: next });
    setSaving(false);
    setRenamingHeader(false);
    if (result.error) {
      setSaveError(result.error);
      setName(project.name);
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const result = await sendJsonFull(base, 'PATCH', {
      name: name.trim(),
      description: description.trim() || null,
      instructions: instructions.trim() || null,
    });
    setSaving(false);
    if (result.error) {
      setSaveError(result.error);
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    setFileError(null);
    for (const file of [...list]) {
      const result = await chatClient.uploadAttachment(tenantId, { projectId: project.id }, file);
      if (result.error) setFileError(`${file.name}: ${result.error}`);
    }
    setUploading(false);
    router.refresh();
  };

  const removeFile = async (id: string) => {
    await chatClient.deleteAttachment(tenantId, id);
    router.refresh();
  };

  const addNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    const result = await sendJsonFull(`${base}/memory`, 'POST', { content: note.trim() });
    setBusy(false);
    if (!result.error) {
      setNote('');
      router.refresh();
    }
  };

  const forget = async (ids: string[] | 'all') => {
    setBusy(true);
    await sendJsonFull(`${base}/memory`, 'DELETE', ids === 'all' ? { all: true } : { ids });
    setBusy(false);
    router.refresh();
  };

  const remove = async () => {
    setBusy(true);
    const result = await sendJsonFull(deleteRoute, 'DELETE');
    setBusy(false);
    if (!result.error) {
      router.push(indexHref);
      router.refresh();
    }
  };

  // The chats inside the project, each with the mark the app menu gives
  // its kind. A code project shows them right under its environment; a
  // chat project after its memory.
  const chatsSection = (
    <section className={sectionClass}>
      <h2 className="mb-2 text-sm font-semibold">Chats in this project</h2>
      {chats.length === 0 ? (
        <p className="text-sm text-gray-500">No chats yet.</p>
      ) : (
        <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {chats.map((chat) => (
            <li key={chat.id}>
              <Link
                href={`/${slug}/chat/${chat.id}`}
                className="flex items-center gap-2 py-1.5 hover:underline"
              >
                <Icon
                  path={variant === 'code' ? ICONS.code : ICONS.pages}
                  className="h-4 w-4 shrink-0 text-gray-400"
                />
                <span className="min-w-0 flex-1 truncate">{chat.title ?? 'New chat'}</span>
                <span className="text-xs text-gray-500">
                  {chat.ownerName ? `${chat.ownerName} · ` : ''}
                  <LocalTime at={chat.updatedAt} format="date" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <Link
          href={indexHref}
          aria-label={variant === 'code' ? 'Back to Code' : 'Back to Projects'}
          title={variant === 'code' ? 'Back to Code' : 'Back to Projects'}
          className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
        >
          <Icon path={ICONS.chevronLeft} className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          {renamingHeader ? (
            <input
              ref={nameInputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void renameFromHeader()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void renameFromHeader();
                } else if (event.key === 'Escape') {
                  setName(project.name);
                  setRenamingHeader(false);
                }
              }}
              maxLength={200}
              aria-label="Project name"
              disabled={saving}
              className="w-full rounded-md border border-blue-400 bg-white px-1.5 py-0.5 text-sm font-semibold outline-none dark:border-blue-700 dark:bg-gray-900"
            />
          ) : (
            <div className="group flex min-w-0 items-center gap-1.5">
              <h1
                className={`truncate text-sm font-semibold ${canEdit ? 'cursor-text' : ''}`}
                onDoubleClick={startRenaming}
                title={canEdit ? 'Double-click to rename' : undefined}
              >
                {project.name}
              </h1>
              {canEdit ? (
                <button
                  type="button"
                  onClick={startRenaming}
                  aria-label="Rename project"
                  title="Rename"
                  className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100 dark:hover:bg-gray-900 dark:hover:text-gray-200"
                >
                  <Icon path={ICONS.pencil} className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          )}
          <p className="truncate text-xs text-gray-500">
            {role === 'owner'
              ? project.publishedToOrg
                ? `Your ${variant === 'code' ? 'code ' : ''}project · published to the organization`
                : `Your ${variant === 'code' ? 'code ' : ''}project`
              : `Shared by ${project.ownerName ?? 'its owner'} · you can ${canEdit ? 'edit' : 'view'}`}
          </p>
        </div>
        {canEdit ? (
          <ToolsPopover
            tenantId={tenantId}
            selected={project.toolConfig?.connectors ?? null}
            onChange={async (next) => {
              await sendJsonFull(base, 'PATCH', {
                toolConfig: next ? { connectors: next } : null,
              });
              router.refresh();
            }}
            context="project"
            kind={variant === 'code' ? 'code' : 'chat'}
            locked={variant === 'code' ? CODE_PROJECT_CONNECTORS : undefined}
            slug={slug}
          />
        ) : null}
        {role === 'owner' ? (
          <button
            type="button"
            onClick={() => setShare(true)}
            aria-label="Share project"
            title="Share"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.share} className="h-5 w-5" />
          </button>
        ) : null}
        <Link
          href={`/${slug}/chat/new?project=${project.id}`}
          // Opening it creates a chat in the project; only a click may do that.
          prefetch={false}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New chat
        </Link>
      </header>

      <div
        className={
          aside
            ? 'mx-auto max-w-6xl p-4 lg:grid lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:items-start lg:gap-4'
            : 'mx-auto max-w-3xl p-4'
        }
      >
        {aside && wide ? (
          <aside
            className={`${sectionClass} sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto`}
          >
            <h2 className="mb-1 text-sm font-semibold">Files</h2>
            {aside}
          </aside>
        ) : null}
        <div className="space-y-4">
          {aside && !wide ? (
            <details className={sectionClass}>
              <summary className="cursor-pointer text-sm font-semibold">Files</summary>
              <div className="mt-2">{aside}</div>
            </details>
          ) : null}
          {before}
          {variant === 'code' ? chatsSection : null}
          {variant === 'code' ? (
            <section className={sectionClass}>
              <details open className="group">
                <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
                  <Icon
                    path={ICONS.chevron}
                    className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-90"
                  />
                  <span className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold">README</h2>
                    <p className="text-xs text-gray-500">
                      {readme
                        ? `${readme.path} on the project’s branch, as Bitbucket has it.`
                        : 'The repository’s README, when it has one.'}
                    </p>
                  </span>
                </summary>
                <div className="mt-3">
                  {readme ? (
                    <Markdown text={readme.text} />
                  ) : (
                    <p className="text-sm text-gray-500">No README was found in the repository.</p>
                  )}
                </div>
              </details>
            </section>
          ) : null}
          <section className={sectionClass}>
            <h2 className="mb-2 text-sm font-semibold">About</h2>
            {canEdit ? (
              <div className="space-y-3">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-label="Project name"
                  maxLength={200}
                  className={inputClass}
                />
                {variant === 'code' ? null : (
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Description (optional)"
                    aria-label="Description"
                    maxLength={2000}
                    className={inputClass}
                  />
                )}
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500">
                    Instructions — what every chat in this project should know and how it should
                    behave
                  </span>
                  <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    rows={variant === 'code' ? 12 : 6}
                    maxLength={20_000}
                    className={inputClass}
                  />
                  {!project.instructions && defaultInstructions && instructions.trim() ? (
                    <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
                      A developer’s standing brief, not saved yet — change it as you like, then Save
                      keeps it for every chat in this project.
                    </span>
                  ) : null}
                </label>
                <div className="flex items-center gap-2">
                  {saveError ? <p className="text-sm text-red-600">{saveError}</p> : null}
                  {savedAt && !dirty ? <p className="text-xs text-gray-500">Saved.</p> : null}
                  <button
                    type="button"
                    disabled={!dirty || saving || !name.trim()}
                    onClick={() => void save()}
                    className="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                {project.description && variant !== 'code' ? (
                  <p className="break-words">{project.description}</p>
                ) : null}
                {project.instructions ? (
                  <div>
                    <p className="text-xs font-medium text-gray-500">Instructions</p>
                    <p className="whitespace-pre-wrap break-words">{project.instructions}</p>
                  </div>
                ) : (
                  <p className="text-gray-500">No instructions.</p>
                )}
              </div>
            )}
          </section>

          {variant === 'code' ? null : (
            <section className={sectionClass}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold">Files</h2>
                {canEdit ? (
                  <>
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={() => fileInput.current?.click()}
                      className="ml-auto rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
                    >
                      {uploading ? 'Uploading…' : 'Add files'}
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        void upload(event.target.files);
                        event.target.value = '';
                      }}
                    />
                  </>
                ) : null}
              </div>
              {files.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No files yet. Files here are readable in every chat of the project.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {files.map((file) => (
                    <AttachmentChip
                      key={file.id}
                      tenantId={tenantId}
                      attachment={file}
                      onRemove={canEdit ? () => void removeFile(file.id) : undefined}
                    />
                  ))}
                </div>
              )}
              {fileError ? <p className="mt-1 text-xs text-red-600">{fileError}</p> : null}
            </section>
          )}

          <section className={sectionClass}>
            <div className="mb-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Memory</h2>
                {canEdit && memory.entries.length > 0 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void forget('all')}
                    className="ml-auto text-xs text-red-600 hover:underline dark:text-red-400"
                  >
                    Forget all
                  </button>
                ) : null}
              </div>
              <p className="text-xs text-gray-500">
                Notes the assistant keeps across this project's chats.
              </p>
            </div>
            {memory.summary ? (
              <p className="mb-2 rounded-md bg-gray-50 p-2 text-sm dark:bg-gray-900">
                {memory.summary}
              </p>
            ) : null}
            {memory.entries.length === 0 ? (
              <p className="text-sm text-gray-500">Nothing remembered yet.</p>
            ) : (
              <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800">
                {memory.entries.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      {entry.content}
                      <span className="block text-xs text-gray-500">
                        <LocalTime at={entry.createdAt} format="date" />
                        {entry.authorName ? ` · ${entry.authorName}` : ''}
                      </span>
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void forget([entry.id])}
                        aria-label="Forget this note"
                        className="rounded p-1 text-gray-400 hover:text-red-600"
                      >
                        <Icon path={ICONS.trash} className="h-4 w-4" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canEdit ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void addNote();
                }}
                className="mt-2 flex gap-2"
              >
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add a note the assistant should remember"
                  maxLength={500}
                  className={inputClass}
                />
                <button
                  type="submit"
                  disabled={busy || !note.trim()}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  Add
                </button>
              </form>
            ) : null}
          </section>

          {variant === 'code' ? null : chatsSection}

          {role === 'owner' ? (
            <section className={sectionClass}>
              <h2 className="mb-2 text-sm font-semibold">Danger zone</h2>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                Delete project
              </button>
            </section>
          ) : null}
        </div>
      </div>

      {share ? (
        <ShareModal
          tenantId={tenantId}
          kind="chat_project"
          resourceId={project.id}
          title={`Share “${project.name}”`}
          published={project.publishedToOrg}
          onClose={() => setShare(false)}
        />
      ) : null}
      {confirmDelete ? (
        <Modal title="Delete project" onClose={() => setConfirmDelete(false)}>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            {variant === 'code'
              ? 'The project’s checkout on the sandbox, its environment variables, memory and shares are deleted — anything not pushed is lost. Chats inside it are kept and simply leave the project.'
              : "The project's files, memory and shares are deleted. Chats inside it are kept and simply leave the project."}
          </p>
          <DialogFooter
            busy={busy}
            error={null}
            label="Delete"
            danger
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => void remove()}
          />
        </Modal>
      ) : null}
    </div>
  );
}
