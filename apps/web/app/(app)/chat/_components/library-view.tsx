'use client';

/**
 * One library: its prompts as cards, an editor for editors (with Refine,
 * which rewrites a prompt or drafts one — prompt-editor.model.ts), and the
 * share dialog for the owner. Deleting a library is the owner's.
 */

import { useCallback, useEffect, useReducer, useState } from 'react';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';
import { chatClient } from '@/lib/chat/client';
import { DialogFooter } from './chat-nav';
import ShareModal from './share-modal';
import { ScopeSelect } from './libraries-index';
import PromptRefineModal from './prompt-refine-modal';
import {
  bodyLocked,
  canRefine,
  canSave,
  editorOpen,
  initialEditor,
  promptEditorReducer,
  promptQuestions,
  questionsSummary,
  refineBody,
  refineButtonLabel,
  refinedNote,
  saveBody,
  shouldAskNow,
  type PromptProposal,
} from './prompt-editor.model';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

interface PromptItem {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function LibraryView({
  library,
  prompts,
}: {
  library: {
    id: string;
    name: string;
    description: string | null;
    scope: 'any' | 'code';
    role: 'owner' | 'editor' | 'viewer';
  };
  prompts: PromptItem[];
}) {
  const router = useRouter();
  const canEdit = library.role !== 'viewer';
  const base = `/api/chat/prompt-libraries/${library.id}`;
  const [editor, dispatch] = useReducer(promptEditorReducer, initialEditor);
  const shareAnchor = useCoachAnchor('library-share');
  const newPromptAnchor = useCoachAnchor('library-new-prompt');
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [scope, setScope] = useState(library.scope);
  const [scopeError, setScopeError] = useState<string | null>(null);

  const changeScope = async (next: 'any' | 'code') => {
    const before = scope;
    setScope(next);
    setScopeError(null);
    const result = await sendJsonFull(base, 'PATCH', { scope: next });
    if (result.error) {
      setScope(before);
      setScopeError(result.error);
    }
  };

  const open = (prompt: PromptItem | 'new') =>
    dispatch({
      type: 'opened',
      prompt: prompt === 'new' ? 'new' : { id: prompt.id, title: prompt.title, body: prompt.body },
    });

  const save = async () => {
    if (!canSave(editor) || editor.target === null) return;
    dispatch({ type: 'saveStarted' });
    const result =
      editor.target === 'new'
        ? await sendJsonFull(`${base}/prompts`, 'POST', saveBody(editor))
        : await sendJsonFull(`${base}/prompts/${editor.target.id}`, 'PATCH', saveBody(editor));
    if (result.error) {
      dispatch({ type: 'saveFailed', error: result.error });
      return;
    }
    dispatch({ type: 'saved' });
    router.refresh();
  };

  // Refine: with a draft the dialog asks as soon as it opens (the roster
  // loads the first time); with none it waits to be told what to write.
  const openRefine = async () => {
    dispatch({ type: 'refineOpened' });
    if (editor.refine.models) return;
    const result = await chatClient.models();
    dispatch({ type: 'modelsLoaded', models: result.data?.models ?? [] });
  };
  const refine = useCallback(async () => {
    if (!canRefine(editor)) return;
    dispatch({ type: 'refineStarted' });
    const result = await sendJsonFull<PromptProposal>(
      `${base}/prompts/refine`,
      'POST',
      refineBody(editor)
    );
    if (result.error || !result.data) {
      dispatch({
        type: 'refineFailed',
        error: result.error ?? 'The model could not refine the prompt. Try again.',
      });
      return;
    }
    dispatch({ type: 'refineAnswered', proposal: result.data });
  }, [editor, base]);
  const askNow = shouldAskNow(editor);
  useEffect(() => {
    if (askNow) void refine();
  }, [askNow, refine]);

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
      router.push(`/chat/prompts`);
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
                ? 'Your library'
                : `Shared · you can ${canEdit ? 'edit' : 'view'}`)}
          </p>
        </div>
        {library.role === 'owner' ? (
          <button
            type="button"
            onClick={() => setShare(true)}
            aria-label="Share library"
            title="Share"
            {...shareAnchor}
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
            {...newPromptAnchor}
          >
            New prompt
          </button>
        ) : null}
      </header>

      <div className="mx-auto max-w-3xl space-y-3 p-4">
        {canEdit ? (
          <div className="max-w-xs">
            <ScopeSelect value={scope} onChange={(next) => void changeScope(next)} />
            {scopeError ? <p className="mt-1 text-xs text-red-600">{scopeError}</p> : null}
          </div>
        ) : scope === 'code' ? (
          <p className="text-xs text-gray-500">Offered in code projects only.</p>
        ) : null}
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
              <p className="text-sm whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
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

      {editorOpen(editor) ? (
        <Modal
          title={editor.target === 'new' ? 'New prompt' : 'Edit prompt'}
          onClose={() => dispatch({ type: 'closed' })}
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
              value={editor.title}
              onChange={(event) => dispatch({ type: 'titleTyped', text: event.target.value })}
              placeholder="Title"
              maxLength={200}
              required
              className={inputClass}
            />
            <textarea
              value={editor.body}
              readOnly={bodyLocked(editor)}
              onChange={(event) => dispatch({ type: 'bodyTyped', text: event.target.value })}
              placeholder="The prompt text. Use {{name}} or {{name:type}} for what changes each time."
              rows={8}
              maxLength={20_000}
              required
              className={inputClass}
            />
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1 text-xs text-gray-500">
                {questionsSummary(editor.body) ? <p>{questionsSummary(editor.body)}</p> : null}
                {refinedNote(editor) ? (
                  <p className="text-violet-700 dark:text-violet-300">{refinedNote(editor)}</p>
                ) : null}
                {promptQuestions(editor.body).problems.length > 0 ? (
                  <ul className="list-disc pl-4 text-amber-700 dark:text-amber-300">
                    {promptQuestions(editor.body).problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void openRefine()}
                disabled={editor.busy}
                className="flex shrink-0 items-center gap-1 rounded-md border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950"
              >
                <Icon path={ICONS.sparkles} className="h-3.5 w-3.5" />
                {refineButtonLabel(editor)}
              </button>
            </div>
            <DialogFooter
              busy={editor.busy || editor.refine.asking}
              error={editor.error}
              label="Save"
              onCancel={() => dispatch({ type: 'closed' })}
            />
          </form>
        </Modal>
      ) : null}
      {editor.refine.open ? (
        <PromptRefineModal state={editor} dispatch={dispatch} onAsk={() => void refine()} />
      ) : null}
      {share ? (
        <ShareModal
          kind="prompt_library"
          resourceId={library.id}
          title={`Share “${library.name}”`}
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
