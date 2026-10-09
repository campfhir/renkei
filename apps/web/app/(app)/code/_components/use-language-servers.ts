'use client';

/**
 * The code pane's language servers, one per language the sandbox
 * worker has a server for: started the first time a file of that
 * language is shown in Monaco, kept for the pane's lifetime, shared by
 * every open file of the language. `GET …/lsp` says which servers the
 * worker has and whether the checkout is ready; before both, and for a
 * language with no server, the file gets the tokenizer alone as it
 * always did — the status line says which.
 *
 * Held by use-code-pane.ts rather than the editor, because the editor
 * remounts as the pane moves between a column and a tab and a server
 * should not be started again each time. A go-to-definition that lands
 * in another file opens it as a pane tab and reveals the range once its
 * model is on screen. The client id is kept per project in
 * sessionStorage, so a reload gets its still-running servers back from
 * the worker rather than starting them again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
// The package's index reaches node built-ins (the egress guard); the browser takes the registry alone.
import { languageServerFor, lspLanguageIdFor } from '@renkei/connector-sandbox/lsp';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { languageForPath } from '@/lib/code/language';
import { paneLanguageId } from '@/lib/monaco/pane-languages';
import { LspClient } from '@/lib/lsp/client';
import {
  attachLanguageServer,
  type LanguageServerAttachment,
  type MonacoApi,
} from '@/lib/lsp/monaco';
import type { LspServerCapabilities } from '@/lib/lsp/protocol';

export type LanguageServerStatus =
  | { state: 'unavailable'; label: string }
  | { state: 'starting'; label: string }
  | { state: 'ready'; label: string; name?: string }
  | { state: 'failed'; label: string; detail: string }
  | { state: 'exited'; label: string; detail: string };

export interface LanguageServersHandle {
  /** What the status line says for a file's language; null when nothing applies (no server is defined, or no checkout yet). */
  statusFor: (language: string) => LanguageServerStatus | null;
  /** From the editor: Monaco is loaded and an editor is up. */
  editorMounted: (monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor) => void;
  editorUnmounted: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
  /** From the editor: this model is on screen; keep it in step with its language's server. */
  modelShown: (model: Monaco.editor.ITextModel, path: string, language: string) => void;
  /** From the pane: the tab closed. */
  closed: (path: string) => void;
  /** From the pane: the file was saved to the checkout. */
  saved: (path: string) => void;
  /** Start a language's server again after a failure or an exit. */
  retry: (language: string) => void;
}

interface Availability {
  available: string[];
  ready: boolean;
}

interface OpenedSession {
  id: string;
  server: string;
  rootUri: string;
  capabilities: LspServerCapabilities;
  serverInfo: { name?: string } | null;
}

interface Entry {
  client: LspClient | null;
  attachment: LanguageServerAttachment | null;
  pending: Shown[];
}

interface Shown {
  model: Monaco.editor.ITextModel;
  path: string;
  language: string;
}

interface Reveal {
  path: string;
  range: Monaco.IRange;
}

function clientIdFor(base: string): string {
  const key = `code-pane:lsp-client:${base}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
  } catch {
    // No storage: a fresh id, then.
  }
  const id = `ed-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  try {
    sessionStorage.setItem(key, id);
  } catch {
    // Not remembered; a reload starts servers afresh.
  }
  return id;
}

/** The pane's Monaco URI for a checkout path — what code-monaco.tsx passes as `path`. */
export function modelPath(path: string): string {
  return `file:///${path}`;
}

/** The registered editor opener is one per Monaco; this is the pane it currently serves. */
let currentOpener:
  ((resource: Monaco.Uri, selection?: Monaco.IRange | Monaco.IPosition) => boolean) | null = null;
let openerRegistered = false;

export function useLanguageServers({
  base,
  enabled,
  checkoutReady,
  openFile,
}: {
  base: string;
  /** The pane is on screen; nothing is asked before it is. */
  enabled: boolean;
  /** The checkout exists to run a server in (`pane.available`). */
  checkoutReady: boolean;
  /** Open a checkout file as a pane tab (a definition elsewhere). */
  openFile: (path: string) => void;
}): LanguageServersHandle {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [statuses, setStatuses] = useState<Record<string, LanguageServerStatus>>({});
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const entries = useRef(new Map<string, Entry>());
  const shown = useRef(new Map<string, Shown>());
  const reveal = useRef<Reveal | null>(null);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const clientId = useMemo(
    () => (typeof window === 'undefined' ? 'ssr' : clientIdFor(base)),
    [base]
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getJson<Availability>(`${base}/lsp`).then((result) => {
      if (cancelled) return;
      setAvailability(result.data ?? { available: [], ready: false });
    });
    return () => {
      cancelled = true;
    };
  }, [base, enabled, checkoutReady]);

  const setStatus = useCallback((server: string, status: LanguageServerStatus) => {
    setStatuses((current) => ({ ...current, [server]: status }));
  }, []);

  const revealIfPending = useCallback((path: string) => {
    const editor = editorRef.current;
    const pending = reveal.current;
    if (!editor || !pending || pending.path !== path) return;
    const model = editor.getModel();
    if (!model || model.uri.path !== `/${path}`) return;
    reveal.current = null;
    editor.setSelection(pending.range);
    editor.revealRangeInCenter(pending.range);
    editor.focus();
  }, []);

  const loadModel = useCallback(
    async (path: string): Promise<Monaco.editor.ITextModel | null> => {
      const monaco = monacoRef.current;
      if (!monaco) return null;
      const uri = monaco.Uri.parse(modelPath(path));
      const existing = monaco.editor.getModel(uri);
      if (existing) return existing;
      const result = await getJson<{ text: string; binary: boolean }>(
        `${base}/files?path=${encodeURIComponent(path)}`
      );
      if (!result.data || result.data.binary) return null;
      // Made between the fetch and now by the editor showing the file.
      return (
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(result.data.text, paneLanguageId(languageForPath(path)), uri)
      );
    },
    [base]
  );

  const start = useCallback(
    async (server: string, label: string, languages: readonly string[]) => {
      const entry: Entry = { client: null, attachment: null, pending: [] };
      entries.current.set(server, entry);
      setStatus(server, { state: 'starting', label });
      const opened = await sendJsonFull<{ session: OpenedSession }>(`${base}/lsp`, 'POST', {
        server,
        clientId,
      });
      // The pane may have moved on (unmounted, or a retry replaced this entry).
      if (entries.current.get(server) !== entry) return;
      const monaco = monacoRef.current;
      if (!opened.data?.session || !monaco) {
        entries.current.delete(server);
        setStatus(server, {
          state: 'failed',
          label,
          detail: opened.error ?? 'The language server could not be started.',
        });
        return;
      }
      const session = opened.data.session;
      const client = new LspClient({
        url: `${base}/lsp/${session.id}`,
        server,
        rootUri: session.rootUri,
        capabilities: session.capabilities,
      });
      client.onExit((info) => {
        if (entries.current.get(server) !== entry) return;
        entry.attachment?.dispose();
        client.dispose();
        entries.current.delete(server);
        const said = info.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
        setStatus(server, {
          state: 'exited',
          label,
          detail:
            said || (info.signal ? `killed (${info.signal})` : `exit code ${info.code ?? '?'}`),
        });
      });
      client.connect();
      const attachment = attachLanguageServer({
        monaco,
        client,
        // The pane's own ids for the languages the server takes.
        languages: languages.map(paneLanguageId),
        modelUriForPath: (path) => monaco.Uri.parse(modelPath(path)),
        loadModel,
      });
      entry.client = client;
      entry.attachment = attachment;
      for (const waiting of entry.pending.splice(0)) {
        if (!waiting.model.isDisposed()) {
          attachment.syncModel(
            waiting.model,
            waiting.path,
            lspLanguageIdFor(waiting.path, waiting.language)
          );
        }
      }
      setStatus(server, { state: 'ready', label, name: session.serverInfo?.name });
    },
    [base, clientId, loadModel, setStatus]
  );

  const modelShown = useCallback(
    (model: Monaco.editor.ITextModel, path: string, language: string) => {
      shown.current.set(path, { model, path, language });
      revealIfPending(path);
      const spec = languageServerFor(language);
      if (!spec || !availability?.ready || !availability.available.includes(spec.id)) return;
      const entry = entries.current.get(spec.id);
      if (entry?.attachment) {
        entry.attachment.syncModel(model, path, lspLanguageIdFor(path, language));
        return;
      }
      if (entry) {
        if (!entry.pending.some((waiting) => waiting.path === path)) {
          entry.pending.push({ model, path, language });
        }
        return;
      }
      const status = statuses[spec.id];
      // A server that failed or exited is not started again unasked;
      // Retry in the status line does that.
      if (status?.state === 'failed' || status?.state === 'exited') return;
      const fresh: Entry = { client: null, attachment: null, pending: [{ model, path, language }] };
      entries.current.set(spec.id, fresh);
      void start(spec.id, spec.label, spec.languages).then(() => {
        // `start` made its own entry; the models queued on this one, if
        // any were, are picked up by the next `modelShown`.
      });
    },
    [availability, revealIfPending, start, statuses]
  );

  // The worker's answer arrived after files were already on screen.
  useEffect(() => {
    if (!availability?.ready) return;
    for (const entry of [...shown.current.values()]) {
      if (!entry.model.isDisposed()) modelShown(entry.model, entry.path, entry.language);
    }
    // modelShown changes identity with `statuses` too; running this on
    // every status change would be harmless but pointless.
  }, [availability]);

  const editorMounted = useCallback(
    (monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor) => {
      monacoRef.current = monaco;
      editorRef.current = editor;
      currentOpener = (resource, selection) => {
        if (resource.scheme !== 'file') return false;
        const path = resource.path.replace(/^\//, '');
        if (!path) return false;
        const range: Monaco.IRange | undefined = selection
          ? 'startLineNumber' in selection
            ? selection
            : {
                startLineNumber: selection.lineNumber,
                startColumn: selection.column,
                endLineNumber: selection.lineNumber,
                endColumn: selection.column,
              }
          : undefined;
        const current = editorRef.current;
        const model = current?.getModel();
        if (current && model && model.uri.toString() === resource.toString()) {
          if (range) {
            current.setSelection(range);
            current.revealRangeInCenter(range);
          }
          current.focus();
          return true;
        }
        reveal.current = range ? { path, range } : null;
        openFileRef.current(path);
        return true;
      };
      if (!openerRegistered) {
        openerRegistered = true;
        monaco.editor.registerEditorOpener({
          openCodeEditor: (_source, resource, selection) =>
            currentOpener ? currentOpener(resource, selection) : false,
        });
      }
    },
    []
  );

  const editorUnmounted = useCallback((editor: Monaco.editor.IStandaloneCodeEditor) => {
    if (editorRef.current === editor) editorRef.current = null;
  }, []);

  const closed = useCallback((path: string) => {
    shown.current.delete(path);
    for (const entry of entries.current.values()) {
      entry.attachment?.release(path);
      entry.pending = entry.pending.filter((waiting) => waiting.path !== path);
    }
  }, []);

  const saved = useCallback((path: string) => {
    for (const entry of entries.current.values()) entry.attachment?.saved(path);
  }, []);

  const retry = useCallback(
    (language: string) => {
      const spec = languageServerFor(language);
      if (!spec) return;
      const entry = entries.current.get(spec.id);
      entry?.attachment?.dispose();
      entry?.client?.dispose();
      entries.current.delete(spec.id);
      setStatuses((current) => {
        const next = { ...current };
        delete next[spec.id];
        return next;
      });
      // The next render's modelShown starts it; nudge it for what is on screen now.
      const waiting = [...shown.current.values()].filter((entry) =>
        spec.languages.includes(entry.language)
      );
      if (waiting.length === 0) return;
      const fresh: Entry = { client: null, attachment: null, pending: waiting };
      entries.current.set(spec.id, fresh);
      void start(spec.id, spec.label, spec.languages);
    },
    [start]
  );

  const statusFor = useCallback(
    (language: string): LanguageServerStatus | null => {
      const spec = languageServerFor(language);
      if (!spec || !availability?.ready) return null;
      if (!availability.available.includes(spec.id))
        return { state: 'unavailable', label: spec.label };
      return statuses[spec.id] ?? { state: 'starting', label: spec.label };
    },
    [availability, statuses]
  );

  // Everything down with the pane: the servers are told, the streams closed.
  useEffect(() => {
    const live = entries.current;
    return () => {
      for (const entry of live.values()) {
        entry.attachment?.dispose();
        entry.client?.dispose();
      }
      live.clear();
      if (currentOpener) currentOpener = null;
    };
  }, []);

  return useMemo(
    () => ({ statusFor, editorMounted, editorUnmounted, modelShown, closed, saved, retry }),
    [statusFor, editorMounted, editorUnmounted, modelShown, closed, saved, retry]
  );
}
