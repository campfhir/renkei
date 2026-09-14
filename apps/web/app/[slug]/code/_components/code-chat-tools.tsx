'use client';

/**
 * A code project's chat gets three actions in its title bar, beside
 * Tools — their own buttons on a wide screen, items of the overflow menu
 * on a narrow one: **Environment** — the project's variables, to look
 * at, replace by pasting a `.env`, or prune, without leaving the chat;
 * **Add files**, which puts files a person picks or drops straight into
 * the checkout, untracked, for the chat's tools to read, use and commit;
 * and **Changes**, with the checkout's uncommitted +added −deleted on
 * it, opening every diff side by side on a wide screen and stacked on a
 * narrow one, with the lines of context to taste and a button that asks
 * the chat to commit, push and open a pull request. The counts refresh
 * when a turn ends, since that is when the checkout changes.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import DiffView, { Counts } from './diff-view';

interface DiffFileStat {
  path: string;
  added: number;
  deleted: number;
  status: 'modified' | 'untracked';
}

interface DiffPayload {
  branch: string;
  diff: string;
  files: DiffFileStat[];
  truncated: boolean;
  available: boolean;
}

interface Variable {
  name: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

const CONTEXTS = [3, 10, 25, 100] as const;

export const PULL_REQUEST_ASK =
  'Commit the current changes on a new branch with a clear message, push it, and open a pull request on Bitbucket that says what changed and why.';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

/** What the title bar renders for a code chat, wherever it puts the buttons. */
export interface CodeChatToolsHandle {
  /** The checkout's uncommitted totals, when a checkout is there. */
  stat: { added: number; deleted: number; files: number } | null;
  openEnvironment: () => void;
  openFiles: () => void;
  openChanges: () => void;
  /** The dialogs — rendered once by the caller, outside any menu that closes. */
  modals: ReactNode;
}

/**
 * The state and dialogs behind a code chat's title-bar actions. The bar
 * decides where the triggers go (its own buttons on a wide screen, an
 * overflow menu on a narrow one); the dialogs live here, outside either,
 * so a menu closing never takes an open dialog with it. With no project
 * the hook is inert.
 */
export function useCodeChatTools({
  tenantId,
  projectId,
  canEdit,
  running,
  onAsk,
}: {
  tenantId: string;
  projectId: string | null;
  /** The person may change the environment and ask the chat to act. */
  canEdit: boolean;
  /** A turn is in flight: the counts refresh when it ends. */
  running: boolean;
  /** Sends a message to the chat as the person — the pull request ask. */
  onAsk: ((text: string) => Promise<boolean>) | null;
}): CodeChatToolsHandle {
  const base = `/api/tenant/${tenantId}/code/projects/${projectId ?? ''}`;
  const [stat, setStat] = useState<{ added: number; deleted: number; files: number } | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const refreshStat = useCallback(async () => {
    if (!projectId) return;
    const result = await getJson<DiffPayload>(`${base}/diff?context=0`);
    if (!result.data || !result.data.available) {
      setStat(null);
      return;
    }
    setStat(
      result.data.files.reduce(
        (sum, file) => ({
          added: sum.added + file.added,
          deleted: sum.deleted + file.deleted,
          files: sum.files + 1,
        }),
        { added: 0, deleted: 0, files: 0 }
      )
    );
  }, [base, projectId]);

  useEffect(() => {
    if (!running) void refreshStat();
  }, [running, refreshStat]);

  const modals = projectId ? (
    <>
      {changesOpen ? (
        <ChangesModal
          base={base}
          onClose={() => {
            setChangesOpen(false);
            void refreshStat();
          }}
          onAsk={
            canEdit && onAsk
              ? async () => {
                  const sent = await onAsk(PULL_REQUEST_ASK);
                  if (sent) setChangesOpen(false);
                }
              : null
          }
        />
      ) : null}
      {envOpen ? (
        <EnvironmentModal base={base} canEdit={canEdit} onClose={() => setEnvOpen(false)} />
      ) : null}
      {filesOpen ? (
        <AddFilesModal
          base={base}
          onClose={() => {
            setFilesOpen(false);
            void refreshStat();
          }}
        />
      ) : null}
    </>
  ) : null;

  return {
    stat,
    openEnvironment: () => setEnvOpen(true),
    openFiles: () => setFilesOpen(true),
    openChanges: () => setChangesOpen(true),
    modals,
  };
}

const buttonClass =
  'flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900';

/** The three buttons as the wide title bar shows them. */
export function CodeChatButtons({
  tools,
  canEdit,
}: {
  tools: CodeChatToolsHandle;
  canEdit: boolean;
}) {
  return (
    <>
      <button
        type="button"
        onClick={tools.openEnvironment}
        aria-label="Environment"
        title="The project's environment variables"
        className={buttonClass}
      >
        <Icon path={ICONS.chip} className="h-4 w-4" />
        <span>Environment</span>
      </button>
      {canEdit ? (
        <button
          type="button"
          onClick={tools.openFiles}
          aria-label="Add files"
          title="Add files to the repository's checkout"
          className={buttonClass}
        >
          <Icon path={ICONS.upload} className="h-4 w-4" />
          <span>Add files</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={tools.openChanges}
        aria-label="Changes"
        title="Uncommitted changes in the checkout"
        className={buttonClass}
      >
        <Icon path={ICONS.diff} className="h-4 w-4" />
        <span>Changes</span>
        {tools.stat && tools.stat.files > 0 ? (
          <Counts added={tools.stat.added} deleted={tools.stat.deleted} />
        ) : null}
      </button>
    </>
  );
}

/**
 * Files into the checkout: picked or dropped, each put at its name under
 * an optional folder, as an untracked file the chat's tools then see —
 * git status lists it, the diff shows it, a commit can take it.
 */
function AddFilesModal({ base, onClose }: { base: string; onClose: () => void }) {
  const [folder, setFolder] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const take = (list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = [...list];
    if (incoming.length === 0) return;
    setFiles((current) => {
      const names = new Set(current.map((file) => file.name));
      return [...current, ...incoming.filter((file) => !names.has(file.name))];
    });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer.files);
  };

  const upload = async () => {
    if (files.length === 0) return;
    const prefix = folder.trim().replace(/^\/+|\/+$/g, '');
    setBusy(true);
    setError(null);
    const done: string[] = [];
    for (const file of files) {
      const path = prefix ? `${prefix}/${file.name}` : file.name;
      const response = await fetch(`${base}/files?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: file,
      }).catch(() => null);
      const body = response ? await response.json().catch(() => null) : null;
      if (!response?.ok) {
        setError(`${path}: ${typeof body?.error === 'string' ? body.error : 'not added'}`);
        break;
      }
      done.push(path);
    }
    setBusy(false);
    setAdded((current) => [...current, ...done]);
    setFiles((current) => current.filter((file) => !done.some((path) => path.endsWith(file.name))));
  };

  return (
    <Modal title="Add files" onClose={onClose}>
      <p className="mb-3 text-xs text-gray-500">
        Upload files into the repository’s checkout. They land as untracked files the chat can read,
        use and commit — ask it to once they are in.
      </p>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') input.current?.click();
        }}
        aria-label="Drop files here or choose files"
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-3 py-6 text-center text-sm ${
          dragging
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
            : 'border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900'
        }`}
      >
        <Icon path={ICONS.upload} className="h-5 w-5 text-gray-400" />
        <span>Drop files here, or click to choose</span>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            take(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-xs font-medium text-gray-500">Folder (optional)</span>
        <input
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="docs/assets"
          autoComplete="off"
          spellCheck={false}
          className={`font-mono ${inputClass}`}
        />
      </label>
      {files.length > 0 ? (
        <ul className="mt-3 divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {files.map((file) => (
            <li key={file.name} className="flex items-center gap-2 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.name}</span>
              <span className="text-xs text-gray-500">
                {Math.max(1, Math.round(file.size / 1024))} KB
              </span>
              <button
                type="button"
                onClick={() => setFiles((current) => current.filter((entry) => entry !== file))}
                className="text-xs text-gray-500 hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {added.length > 0 ? (
        <p className="mt-2 text-xs text-green-700 dark:text-green-400">
          Added to the checkout: {added.join(', ')}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {added.length > 0 ? 'Done' : 'Cancel'}
        </button>
        <button
          type="button"
          disabled={busy || files.length === 0}
          onClick={() => void upload()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Adding…' : `Add to repository${files.length > 1 ? ` (${files.length})` : ''}`}
        </button>
      </div>
    </Modal>
  );
}

function ChangesModal({
  base,
  onClose,
  onAsk,
}: {
  base: string;
  onClose: () => void;
  onAsk: (() => Promise<void>) | null;
}) {
  const [context, setContext] = useState<number>(3);
  const [payload, setPayload] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    void getJson<DiffPayload>(`${base}/diff?context=${context}`).then((result) => {
      if (cancelled) return;
      if (result.data) setPayload(result.data);
      else setError(result.error ?? 'The changes could not be read.');
    });
    return () => {
      cancelled = true;
    };
  }, [base, context]);

  const totals = payload
    ? payload.files.reduce(
        (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
        { added: 0, deleted: 0 }
      )
    : null;

  return (
    <Modal title="Changes" onClose={onClose} size="wide">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-gray-500">
        {payload ? (
          <span>
            {payload.available
              ? `${payload.files.length} file${payload.files.length === 1 ? '' : 's'} changed on ${payload.branch || 'the branch'}, uncommitted`
              : 'The checkout is not ready.'}
          </span>
        ) : (
          <span>Loading…</span>
        )}
        {totals ? <Counts added={totals.added} deleted={totals.deleted} /> : null}
        <label className="ml-auto flex items-center gap-1.5">
          Context
          <select
            value={context}
            onChange={(event) => setContext(Number(event.target.value))}
            className="rounded-md border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900"
          >
            {CONTEXTS.map((lines) => (
              <option key={lines} value={lines}>
                {lines} lines
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="max-h-[70vh] overflow-y-auto">
        {payload ? <DiffView diff={payload.diff} /> : null}
        {payload?.truncated ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            The diff was cut short; the counts cover everything.
          </p>
        ) : null}
      </div>
      {onAsk && payload && payload.files.length > 0 ? (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          <p className="mr-auto text-xs text-gray-500">
            The chat commits, pushes and opens the pull request; you see each step.
          </p>
          <button
            type="button"
            disabled={asking}
            onClick={() => {
              setAsking(true);
              void onAsk().finally(() => setAsking(false));
            }}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Ask the chat to open a pull request
          </button>
        </div>
      ) : null}
    </Modal>
  );
}

function EnvironmentModal({
  base,
  canEdit,
  onClose,
}: {
  base: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [variables, setVariables] = useState<Variable[] | null>(null);
  const [text, setText] = useState('');
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const load = useCallback(async () => {
    const result = await getJson<{ variables: Variable[] }>(`${base}/env`);
    if (result.data) setVariables(result.data.variables);
    else setError(result.error ?? 'The environment could not be read.');
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const replace = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ variables: Variable[]; problems: string[] }>(
      `${base}/env`,
      'PUT',
      { env: text }
    );
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The environment could not be saved.');
      return;
    }
    setVariables(result.data.variables);
    setProblems(result.data.problems);
    setText('');
    setPasting(false);
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Remove ${name}? Commands will no longer see it.`)) return;
    setBusy(true);
    const result = await sendJsonFull(`${base}/env`, 'DELETE', { name });
    setBusy(false);
    if (result.error) setError(result.error);
    else await load();
  };

  return (
    <Modal title="Environment" onClose={onClose}>
      <p className="mb-2 text-xs text-gray-500">
        What the project’s commands run with. Values are never shown — not here, not to the model.
      </p>
      {variables === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : variables.length === 0 ? (
        <p className="text-sm text-gray-500">No environment variables.</p>
      ) : (
        <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {variables.map((variable) => (
            <li key={variable.name} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono">{variable.name}</span>
              {canEdit ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(variable.name)}
                  className="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          Not read from the pasted .env: {problems.join('; ')}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {canEdit ? (
        pasting ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void replace();
            }}
            className="mt-3 space-y-2"
          >
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              spellCheck={false}
              aria-label=".env contents"
              placeholder={'NPM_TOKEN=…\nDATABASE_URL=postgres://…'}
              className={`font-mono ${inputClass}`}
            />
            <div className="flex items-center justify-end gap-2">
              <p className="mr-auto text-xs text-gray-500">Replaces every variable.</p>
              <button
                type="button"
                onClick={() => setPasting(false)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !text.trim()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Replace'}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setPasting(true)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {variables && variables.length > 0 ? 'Replace .env' : 'Add .env'}
            </button>
          </div>
        )
      ) : null}
    </Modal>
  );
}
