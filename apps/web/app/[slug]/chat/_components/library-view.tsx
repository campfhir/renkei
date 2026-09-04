'use client';

/**
 * One library: its prompts as cards, an inline editor for editors, and
 * the share dialog for the owner. Deleting a library is the owner's.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';
import { DialogFooter } from './chat-nav';
import ShareModal from './share-modal';

interface PromptItem {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function LibraryView({
  slug,
  tenantId,
  library,
  prompts,
}: {
  slug: string;
  tenantId: string;
  library: {
    id: string;
    name: string;
    description: string | null;
    publishedToOrg: boolean;
    role: 'owner' | 'editor' | 'viewer';
  };
  prompts: PromptItem[];
}) {
  const router = useRouter();
  const canEdit = library.role !== 'viewer';
  const base = `/api/tenant/${tenantId}/chat/prompt-libraries/${library.id}`;
  const [editing, setEditing] = useState<PromptItem | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const open = (prompt: PromptItem | 'new') => {
    setEditing(prompt);
    setTitle(prompt === 'new' ? '' : prompt.title);
    setBody(prompt === 'new' ? '' : prompt.body);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const result =
      editing === 'new'
        ? await sendJsonFull(`${base}/prompts`, 'POST', { title: title.trim(), body: body.trim() })
        : editing
          ? await sendJsonFull(`${base}/prompts/${editing.id}`, 'PATCH', {
              title: title.trim(),
              body: body.trim(),
            })
          : { error: null };
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(null);
    router.refresh();
  };

  const removePrompt = async (id: string) => {
    setBusy(true);
    await sendJsonFull(`${base}/prompts/${id}`, 'DELETE');
    setBusy(false);
    router.refresh();
  };

  const removeLibrary = async () => {
    setBusy(true);
    const result = await sendJsonFull(base, 'DELETE');
    setBusy(false);
    if (!result.error) {
      router.push(`/${slug}/chat/prompts`);
      router.refresh();
    }
  };

  const copy = (prompt: PromptItem) => {
    void navigator.clipboard?.writeText(prompt.body).then(() => {
      setCopied(prompt.id);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{library.name}</h1>
          <p className="truncate text-xs text-gray-500">
            {library.description ??
              (library.role === 'owner'
                ? library.publishedToOrg
                  ? 'Published to the organization'
                  : 'Your library'
                : `Shared · you can ${canEdit ? 'edit' : 'view'}`)}
          </p>
        </div>
        {library.role === 'owner' ? (
          <button
            type="button"
            onClick={() => setShare(true)}
            aria-label="Share library"
            title="Share"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.share} className="h-5 w-5" />
          </button>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={() => open('new')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            New prompt
          </button>
        ) : null}
      </header>

      <div className="mx-auto max-w-3xl space-y-3 p-4">
        {prompts.length === 0 ? (
          <p className="text-sm text-gray-500">
            {canEdit ? 'No prompts yet — add the first one.' : 'This library is empty.'}
          </p>
        ) : (
          prompts.map((prompt) => (
            <article
              key={prompt.id}
              className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
            >
              <div className="mb-1 flex items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{prompt.title}</h2>
                <button
                  type="button"
                  onClick={() => copy(prompt)}
                  className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  {copied === prompt.id ? 'Copied' : 'Copy'}
                </button>
                {canEdit ? (
                  <>
                    <button
                      type="button"
                      onClick={() => open(prompt)}
                      aria-label="Edit prompt"
                      className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
                    >
                      <Icon path={ICONS.pencil} className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removePrompt(prompt.id)}
                      aria-label="Delete prompt"
                      className="rounded p-1 text-gray-500 hover:text-red-600"
                    >
                      <Icon path={ICONS.trash} className="h-4 w-4" />
                    </button>
                  </>
                ) : null}
              </div>
              <p className="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                {prompt.body}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                Updated <LocalTime at={prompt.updatedAt} format="date" />
              </p>
            </article>
          ))
        )}
        {library.role === 'owner' ? (
          <div className="pt-4">
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
            >
              Delete library
            </button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <Modal
          title={editing === 'new' ? 'New prompt' : 'Edit prompt'}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="space-y-3"
          >
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Title"
              maxLength={200}
              required
              className={inputClass}
            />
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="The prompt text"
              rows={8}
              maxLength={20_000}
              required
              className={inputClass}
            />
            <DialogFooter
              busy={busy}
              error={error}
              label="Save"
              onCancel={() => setEditing(null)}
            />
          </form>
        </Modal>
      ) : null}
      {share ? (
        <ShareModal
          tenantId={tenantId}
          kind="prompt_library"
          resourceId={library.id}
          title={`Share “${library.name}”`}
          published={library.publishedToOrg}
          onClose={() => setShare(false)}
        />
      ) : null}
      {confirmDelete ? (
        <Modal title="Delete library" onClose={() => setConfirmDelete(false)}>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            Every prompt in it is deleted, for everyone it was shared with.
          </p>
          <DialogFooter
            busy={busy}
            error={null}
            label="Delete"
            danger
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => void removeLibrary()}
          />
        </Modal>
      ) : null}
    </div>
  );
}
