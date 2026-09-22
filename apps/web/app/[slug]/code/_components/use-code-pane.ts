'use client';

/**
 * The code pane's state, held by the chat page rather than the pane:
 * the pane moves between a column beside the chat and a tab under its
 * title bar as the page is resized, and React remounts what moves, so
 * the open files and their unsaved edits live here and survive it.
 *
 * What it holds: the open files (text as edited, text as last read or
 * saved, and the etag of that), the working tree's changed files
 * (`…/diff?stat=1`, the same call the Changes badge makes), which files
 * this browser saved, and the save itself — `PUT …/files` with
 * `If-Match`, so a file the chat's turn rewrote underneath is never
 * overwritten unasked: the save is refused and the file is marked in
 * conflict, with the checkout's text kept for Compare, Reload theirs and
 * Keep mine. A turn ending (`refreshKey`) reads every open file again:
 * a clean one simply follows the checkout, a dirty one that moved is
 * marked the same way.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getJson } from '@/lib/fetch-json';
import type { ChatNote } from '@/lib/code/note-text';

export interface CodePaneFile {
  path: string;
  state: 'loading' | 'ready' | 'error';
  /** The text in the editor, unsaved edits included. */
  text: string;
  /** The text as last read from, or saved to, the checkout. */
  savedText: string;
  etag: string;
  language: string;
  editable: boolean;
  source: 'checkout' | 'bitbucket' | 'github';
  binary: boolean;
  truncated: boolean;
  error: string | null;
  saving: boolean;
  /** The checkout's file is not the one this text was read from. */
  conflict: { etag: string; text: string | null } | null;
}

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  status: 'modified' | 'untracked';
}

interface FilePayload {
  path: string;
  text: string;
  binary: boolean;
  truncated: boolean;
  etag: string;
  language: string;
  source: 'checkout' | 'bitbucket' | 'github';
  editable: boolean;
}

interface StatPayload {
  branch: string;
  files: ChangedFile[];
  available: boolean;
}

export interface CodePaneHandle {
  tabs: string[];
  active: string | null;
  files: Record<string, CodePaneFile>;
  changed: ChangedFile[];
  /** The checkout is there to read and write; false before a clone. */
  available: boolean;
  branch: string | null;
  dirtyPaths: string[];
  /** Files this browser saved from the pane, for the commit dialog's tags. */
  editedHere: ReadonlySet<string>;
  open: (path: string) => void;
  close: (path: string) => void;
  activate: (path: string | null) => void;
  setText: (path: string, text: string) => void;
  save: (path: string, options?: { force?: boolean }) => Promise<boolean>;
  saveAll: () => Promise<boolean>;
  discard: (path: string) => void;
  reloadTheirs: (path: string) => void;
  /** Read the changed files and every open file again. */
  refresh: () => void;
}

const FRESH: Omit<CodePaneFile, 'path'> = {
  state: 'loading',
  text: '',
  savedText: '',
  etag: '',
  language: 'plaintext',
  editable: false,
  source: 'checkout',
  binary: false,
  truncated: false,
  error: null,
  saving: false,
  conflict: null,
};

function tabsKey(chatId: string): string {
  return `code-pane:tabs:${chatId}`;
}

function readTabs(chatId: string): { tabs: string[]; active: string | null } {
  try {
    const raw = sessionStorage.getItem(tabsKey(chatId));
    if (!raw) return { tabs: [], active: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('tabs' in parsed))
      return { tabs: [], active: null };
    const rawTabs: unknown = parsed.tabs;
    const rawActive: unknown = 'active' in parsed ? parsed.active : null;
    const tabs = Array.isArray(rawTabs)
      ? rawTabs.filter((tab): tab is string => typeof tab === 'string')
      : [];
    const active = typeof rawActive === 'string' && tabs.includes(rawActive) ? rawActive : null;
    return { tabs, active };
  } catch {
    return { tabs: [], active: null };
  }
}

export function useCodePane({
  tenantId,
  projectId,
  chatId,
  enabled,
  refreshKey,
  onNote,
}: {
  tenantId: string;
  projectId: string | null;
  chatId: string;
  /** The pane is on screen somewhere; nothing is fetched before it is. */
  enabled: boolean;
  /** Bumped when a turn ends: the checkout changed. */
  refreshKey: number;
  /** Tell the chat what was done to the checkout (a note row). */
  onNote: (note: ChatNote) => void;
}): CodePaneHandle {
  const base = `/api/tenant/${tenantId}/code/projects/${projectId ?? ''}`;
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, CodePaneFile>>({});
  const [changed, setChanged] = useState<ChangedFile[]>([]);
  const [available, setAvailable] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [editedHere, setEditedHere] = useState<Set<string>>(() => new Set());
  const filesRef = useRef(files);
  filesRef.current = files;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // The open files of this chat, from the last visit in this tab.
  const restored = useRef(false);
  useEffect(() => {
    if (!projectId || restored.current) return;
    restored.current = true;
    const saved = readTabs(chatId);
    setTabs(saved.tabs);
    setActive(saved.active);
  }, [chatId, projectId]);
  useEffect(() => {
    if (!projectId || !restored.current) return;
    try {
      sessionStorage.setItem(tabsKey(chatId), JSON.stringify({ tabs, active }));
    } catch {
      // Storage may be unavailable; the tabs are then this visit's only.
    }
  }, [chatId, projectId, tabs, active]);

  const patch = useCallback((path: string, update: (file: CodePaneFile) => CodePaneFile) => {
    setFiles((current) => {
      const file = current[path];
      return file ? { ...current, [path]: update(file) } : current;
    });
  }, []);

  /** Read a file from the checkout; `follow` decides what to do with a dirty one. */
  const read = useCallback(
    async (path: string, follow: boolean) => {
      const result = await getJson<FilePayload>(`${base}/files?path=${encodeURIComponent(path)}`);
      setFiles((current) => {
        const file = current[path];
        if (!file) return current;
        if (!result.data) {
          return {
            ...current,
            [path]: { ...file, state: 'error', error: result.error ?? 'Could not read the file.' },
          };
        }
        const payload = result.data;
        const dirty = file.state === 'ready' && file.text !== file.savedText;
        if (follow && dirty) {
          // Unsaved edits stay; a changed checkout is a conflict to resolve.
          if (payload.etag === file.etag) return current;
          return {
            ...current,
            [path]: { ...file, conflict: { etag: payload.etag, text: payload.text } },
          };
        }
        return {
          ...current,
          [path]: {
            ...file,
            state: 'ready',
            text: payload.text,
            savedText: payload.text,
            etag: payload.etag,
            language: payload.language,
            editable: payload.editable,
            source: payload.source,
            binary: payload.binary,
            truncated: payload.truncated,
            error: null,
            conflict: null,
          },
        };
      });
    },
    [base]
  );

  const refreshChanged = useCallback(async () => {
    if (!projectId) return;
    const result = await getJson<StatPayload>(`${base}/diff?context=0&stat=1`);
    if (!result.data) return;
    setAvailable(result.data.available);
    setBranch(result.data.branch || null);
    setChanged(result.data.available ? result.data.files : []);
  }, [base, projectId]);

  useEffect(() => {
    if (enabled && projectId) void refreshChanged();
  }, [enabled, projectId, refreshChanged]);

  const open = useCallback(
    (path: string) => {
      setTabs((current) => (current.includes(path) ? current : [...current, path]));
      setActive(path);
      if (!filesRef.current[path]) {
        setFiles((current) => ({ ...current, [path]: { path, ...FRESH } }));
        void read(path, false);
      }
    },
    [read]
  );

  // Restored tabs need their files read once the pane is on screen.
  useEffect(() => {
    if (!enabled) return;
    for (const path of tabs) {
      if (!filesRef.current[path]) {
        setFiles((current) => ({ ...current, [path]: { path, ...FRESH } }));
        void read(path, false);
      }
    }
  }, [enabled, tabs, read]);

  const close = useCallback((path: string) => {
    const current = tabsRef.current;
    const index = current.indexOf(path);
    const next = current.filter((tab) => tab !== path);
    setTabs(next);
    setActive((active) =>
      active === path ? (next[Math.min(index, next.length - 1)] ?? null) : active
    );
    setFiles((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  const setText = useCallback(
    (path: string, text: string) => patch(path, (file) => ({ ...file, text })),
    [patch]
  );

  const save = useCallback(
    async (path: string, options: { force?: boolean } = {}): Promise<boolean> => {
      const file = filesRef.current[path];
      if (!file || file.state !== 'ready' || !file.editable || file.saving) return false;
      const text = file.text;
      patch(path, (current) => ({ ...current, saving: true }));
      const headers: Record<string, string> = {
        'content-type': 'text/plain; charset=utf-8',
        'x-code-editor': 'save',
      };
      if (!options.force) headers['if-match'] = file.etag;
      const response = await fetch(`${base}/files?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers,
        body: text,
      }).catch(() => null);
      const body = response ? await response.json().catch(() => null) : null;
      if (response?.status === 409 && body?.code === 'conflict') {
        patch(path, (current) => ({
          ...current,
          saving: false,
          conflict: {
            etag: typeof body.etag === 'string' ? body.etag : '',
            text: typeof body.text === 'string' ? body.text : null,
          },
        }));
        return false;
      }
      if (!response?.ok) {
        patch(path, (current) => ({
          ...current,
          saving: false,
          error: typeof body?.error === 'string' ? body.error : 'The file could not be saved.',
        }));
        return false;
      }
      const etag = typeof body?.file?.etag === 'string' ? body.file.etag : file.etag;
      patch(path, (current) => ({
        ...current,
        saving: false,
        savedText: text,
        etag,
        error: null,
        conflict: null,
      }));
      setEditedHere((current) => new Set(current).add(path));
      onNote({ type: 'edit', paths: [path] });
      void refreshChanged();
      return true;
    },
    [base, onNote, patch, refreshChanged]
  );

  const dirtyPaths = useMemo(
    () =>
      tabs.filter((path) => {
        const file = files[path];
        return file?.state === 'ready' && file.text !== file.savedText;
      }),
    [tabs, files]
  );

  const saveAll = useCallback(async (): Promise<boolean> => {
    let all = true;
    for (const path of dirtyPaths) {
      if (!(await save(path))) all = false;
    }
    return all;
  }, [dirtyPaths, save]);

  const discard = useCallback(
    (path: string) => patch(path, (file) => ({ ...file, text: file.savedText, error: null })),
    [patch]
  );

  const reloadTheirs = useCallback(
    (path: string) => {
      const file = filesRef.current[path];
      if (!file?.conflict) return;
      if (file.conflict.text === null) {
        // Gone or unreadable now: read again and let the result say.
        patch(path, (current) => ({ ...current, conflict: null }));
        void read(path, false);
        return;
      }
      const text = file.conflict.text;
      const etag = file.conflict.etag;
      patch(path, (current) => ({
        ...current,
        text,
        savedText: text,
        etag,
        conflict: null,
        error: null,
      }));
    },
    [patch, read]
  );

  const refresh = useCallback(() => {
    void refreshChanged();
    for (const path of Object.keys(filesRef.current)) void read(path, true);
  }, [read, refreshChanged]);

  // A turn ended: the checkout changed.
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    if (enabled) refresh();
  }, [refreshKey, enabled, refresh]);

  // Unsaved edits are lost with the page; say so on the way out.
  useEffect(() => {
    if (dirtyPaths.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyPaths.length]);

  return {
    tabs,
    active,
    files,
    changed,
    available,
    branch,
    dirtyPaths,
    editedHere,
    open,
    close,
    activate: setActive,
    setText,
    save,
    saveAll,
    discard,
    reloadTheirs,
    refresh,
  };
}
