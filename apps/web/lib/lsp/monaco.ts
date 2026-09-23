/**
 * Monaco as a language client. One attachment per server session:
 * registers the providers the server's capabilities allow for the
 * Monaco languages it covers (completion, hover, signature help, go to
 * definition / type / implementation, references, highlights,
 * formatting, code actions with edits, semantic tokens) and draws the
 * server's diagnostics as markers; keeps the documents the pane has open
 * in step with the server (`didOpen`, a debounced whole-text
 * `didChange`, `didSave`, `didClose`). The providers answer only for
 * models this attachment synced, so a second server for the same
 * language elsewhere on the page never gets the wrong file.
 *
 * Positions cross one boundary here: the protocol counts lines and
 * characters from zero, Monaco from one.
 */

import type * as Monaco from 'monaco-editor';
import { LspCancelled, type LspClient } from './client';
import {
  capabilityOn,
  markdownOf,
  pathForUri,
  uriForPath,
  type LspCodeAction,
  type LspCompletionItem,
  type LspCompletionList,
  type LspDiagnostic,
  type LspDocumentHighlight,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspPosition,
  type LspRange,
  type LspSemanticTokens,
  type LspSignatureHelp,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from './protocol';

export type MonacoApi = typeof Monaco;

const CHANGE_DEBOUNCE_MS = 150;

export interface AttachOptions {
  monaco: MonacoApi;
  client: LspClient;
  /** The Monaco language ids this server takes. */
  languages: readonly string[];
  /** The Monaco URI the pane gives a checkout path's model. */
  modelUriForPath: (path: string) => Monaco.Uri;
  /** A checkout file as a model, fetched if need be (cross-file navigation); null when it cannot be. */
  loadModel: (path: string) => Promise<Monaco.editor.ITextModel | null>;
}

export interface LanguageServerAttachment {
  readonly client: LspClient;
  /** Keep a model in step with the server from now until `release` or dispose. Idempotent. */
  syncModel(model: Monaco.editor.ITextModel, path: string, lspLanguageId: string): void;
  /** The pane closed the file: the server hears `didClose` and its markers go. */
  release(path: string): void;
  /** The pane saved the file. */
  saved(path: string): void;
  /** Whether this attachment answers for a model. */
  covers(model: Monaco.editor.ITextModel): boolean;
  dispose(): void;
}

interface Doc {
  model: Monaco.editor.ITextModel;
  path: string;
  uri: string;
  version: number;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  listener: Monaco.IDisposable;
  diagnostics: LspDiagnostic[];
}

export function attachLanguageServer(options: AttachOptions): LanguageServerAttachment {
  const { monaco, client, languages } = options;
  const caps = client.capabilities;
  const rootUri = client.rootUri;
  const owner = `lsp:${client.server}`;
  const docs = new Map<string, Doc>();
  const disposables: Monaco.IDisposable[] = [];
  const unsubscribes: (() => void)[] = [];

  const toPosition = (position: Monaco.IPosition): LspPosition => ({
    line: position.lineNumber - 1,
    character: position.column - 1,
  });
  const toRange = (range: LspRange): Monaco.Range =>
    new monaco.Range(
      range.start.line + 1,
      range.start.character + 1,
      range.end.line + 1,
      range.end.character + 1
    );
  const fromRange = (range: Monaco.IRange): LspRange => ({
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  });

  const docOf = (model: Monaco.editor.ITextModel): Doc | undefined =>
    docs.get(model.uri.toString());

  /** A change the debounce is holding, sent now: a request must read the text as it is. */
  const flush = (doc: Doc): void => {
    if (!doc.dirty) return;
    if (doc.timer) clearTimeout(doc.timer);
    doc.timer = null;
    doc.dirty = false;
    doc.version += 1;
    client.notify('textDocument/didChange', {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: doc.model.getValue() }],
    });
  };

  const textDocument = (doc: Doc) => ({ uri: doc.uri });

  /** The request's answer, or null for a cancellation or a refusal; the editor shows nothing either way. */
  const ask = async <T>(
    doc: Doc,
    method: string,
    params: Record<string, unknown>,
    token: Monaco.CancellationToken
  ): Promise<T | null> => {
    flush(doc);
    try {
      return await client.request<T | null>(
        method,
        { textDocument: textDocument(doc), ...params },
        token
      );
    } catch (error) {
      if (!(error instanceof LspCancelled)) {
        console.warn(
          `[lsp:${client.server}] ${method}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  };

  // ─── Locations across files ────────────────────────────────────────────

  /** A server's location as Monaco's, the file loaded as a model so a jump or a peek has something to show. */
  const toLocationLink = async (
    entry: LspLocation | LspLocationLink
  ): Promise<Monaco.languages.LocationLink | null> => {
    const uri = 'targetUri' in entry ? entry.targetUri : entry.uri;
    const range =
      'targetUri' in entry ? (entry.targetSelectionRange ?? entry.targetRange) : entry.range;
    const path = pathForUri(rootUri, uri);
    if (path === null) {
      // Outside the checkout (a library, a decompiled class): named, not opened.
      return { uri: monaco.Uri.parse(uri), range: toRange(range) };
    }
    const model = await options.loadModel(path);
    if (!model) return null;
    return {
      uri: model.uri,
      range: toRange(range),
      originSelectionRange:
        'originSelectionRange' in entry && entry.originSelectionRange
          ? toRange(entry.originSelectionRange)
          : undefined,
    };
  };

  const toLocations = async (
    result: LspLocation | LspLocation[] | LspLocationLink[] | null
  ): Promise<Monaco.languages.LocationLink[]> => {
    if (!result) return [];
    const entries = Array.isArray(result) ? result : [result];
    const links = await Promise.all(entries.map(toLocationLink));
    return links.filter((link): link is Monaco.languages.LocationLink => link !== null);
  };

  const registerLocationProvider = (
    capability: unknown,
    register: (
      language: string,
      provide: (
        model: Monaco.editor.ITextModel,
        position: Monaco.Position,
        token: Monaco.CancellationToken
      ) => Promise<Monaco.languages.LocationLink[] | null>
    ) => Monaco.IDisposable,
    method: string,
    extraParams: Record<string, unknown> = {}
  ) => {
    if (!capabilityOn(capability)) return;
    for (const language of languages) {
      disposables.push(
        register(language, async (model, position, token) => {
          const doc = docOf(model);
          if (!doc) return null;
          const result = await ask<LspLocation | LspLocation[] | LspLocationLink[]>(
            doc,
            method,
            { position: toPosition(position), ...extraParams },
            token
          );
          return toLocations(result);
        })
      );
    }
  };

  // ─── Providers ─────────────────────────────────────────────────────────

  if (caps.completionProvider) {
    const K = monaco.languages.CompletionItemKind;
    const KINDS: Monaco.languages.CompletionItemKind[] = [
      K.Text,
      K.Method,
      K.Function,
      K.Constructor,
      K.Field,
      K.Variable,
      K.Class,
      K.Interface,
      K.Module,
      K.Property,
      K.Unit,
      K.Value,
      K.Enum,
      K.Keyword,
      K.Snippet,
      K.Color,
      K.File,
      K.Reference,
      K.Folder,
      K.EnumMember,
      K.Constant,
      K.Struct,
      K.Event,
      K.Operator,
      K.TypeParameter,
    ];
    /** The server's item behind each of Monaco's, for resolve. */
    const originals = new WeakMap<Monaco.languages.CompletionItem, LspCompletionItem>();
    const toItem = (
      item: LspCompletionItem,
      defaultRange: Monaco.Range
    ): Monaco.languages.CompletionItem => {
      const edit = item.textEdit;
      const range: Monaco.IRange | Monaco.languages.CompletionItemRanges = edit
        ? 'insert' in edit
          ? { insert: toRange(edit.insert), replace: toRange(edit.replace) }
          : toRange(edit.range)
        : defaultRange;
      const deprecated = item.deprecated || item.tags?.includes(1);
      const made: Monaco.languages.CompletionItem = {
        label: item.label,
        kind: KINDS[(item.kind ?? 1) - 1] ?? K.Text,
        detail: item.detail,
        documentation: documentationOf(item.documentation),
        sortText: item.sortText,
        filterText: item.filterText,
        preselect: item.preselect,
        insertText: edit?.newText ?? item.insertText ?? item.label,
        insertTextRules:
          item.insertTextFormat === 2
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
        range,
        tags: deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
        commitCharacters: item.commitCharacters,
        additionalTextEdits: item.additionalTextEdits?.map(toTextEdit),
      };
      originals.set(made, item);
      return made;
    };
    const provider: Monaco.languages.CompletionItemProvider = {
      triggerCharacters: caps.completionProvider.triggerCharacters,
      provideCompletionItems: async (model, position, context, token) => {
        const doc = docOf(model);
        if (!doc) return null;
        const result = await ask<LspCompletionList | LspCompletionItem[]>(
          doc,
          'textDocument/completion',
          {
            position: toPosition(position),
            context: {
              // Monaco counts from 0 where the protocol counts from 1.
              triggerKind: context.triggerKind + 1,
              triggerCharacter: context.triggerCharacter,
            },
          },
          token
        );
        if (!result) return null;
        const items = Array.isArray(result) ? result : result.items;
        const word = model.getWordUntilPosition(position);
        const defaultRange = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        );
        return {
          suggestions: items.map((item) => toItem(item, defaultRange)),
          incomplete: !Array.isArray(result) && result.isIncomplete,
        };
      },
      resolveCompletionItem: caps.completionProvider.resolveProvider
        ? async (item, token) => {
            const original = originals.get(item);
            if (!original) return item;
            try {
              const resolved = await client.request<LspCompletionItem | null>(
                'completionItem/resolve',
                original,
                token
              );
              if (!resolved) return item;
              const merged: Monaco.languages.CompletionItem = {
                ...item,
                detail: resolved.detail ?? item.detail,
                documentation: documentationOf(resolved.documentation) ?? item.documentation,
                additionalTextEdits:
                  resolved.additionalTextEdits?.map(toTextEdit) ?? item.additionalTextEdits,
              };
              originals.set(merged, original);
              return merged;
            } catch {
              return item;
            }
          }
        : undefined,
    };
    for (const language of languages) {
      disposables.push(monaco.languages.registerCompletionItemProvider(language, provider));
    }
  }

  if (capabilityOn(caps.hoverProvider)) {
    for (const language of languages) {
      disposables.push(
        monaco.languages.registerHoverProvider(language, {
          provideHover: async (model, position, token) => {
            const doc = docOf(model);
            if (!doc) return null;
            const hover = await ask<LspHover>(
              doc,
              'textDocument/hover',
              { position: toPosition(position) },
              token
            );
            if (!hover) return null;
            const contents = markdownOf(hover.contents).map((value) => ({ value }));
            if (contents.length === 0) return null;
            return { contents, range: hover.range ? toRange(hover.range) : undefined };
          },
        })
      );
    }
  }

  if (caps.signatureHelpProvider) {
    for (const language of languages) {
      disposables.push(
        monaco.languages.registerSignatureHelpProvider(language, {
          signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters,
          signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters,
          provideSignatureHelp: async (model, position, token, context) => {
            const doc = docOf(model);
            if (!doc) return null;
            const help = await ask<LspSignatureHelp>(
              doc,
              'textDocument/signatureHelp',
              {
                position: toPosition(position),
                context: {
                  triggerKind: context.triggerKind,
                  triggerCharacter: context.triggerCharacter,
                  isRetrigger: context.isRetrigger,
                },
              },
              token
            );
            if (!help || help.signatures.length === 0) return null;
            return {
              value: {
                signatures: help.signatures.map((signature) => ({
                  label: signature.label,
                  documentation: documentationOf(signature.documentation),
                  parameters: (signature.parameters ?? []).map((parameter) => ({
                    label: parameter.label,
                    documentation: documentationOf(parameter.documentation),
                  })),
                  activeParameter: signature.activeParameter,
                })),
                activeSignature: help.activeSignature ?? 0,
                activeParameter: help.activeParameter ?? 0,
              },
              dispose: () => {},
            };
          },
        })
      );
    }
  }

  registerLocationProvider(
    caps.definitionProvider,
    (language, provide) =>
      monaco.languages.registerDefinitionProvider(language, { provideDefinition: provide }),
    'textDocument/definition'
  );
  registerLocationProvider(
    caps.typeDefinitionProvider,
    (language, provide) =>
      monaco.languages.registerTypeDefinitionProvider(language, { provideTypeDefinition: provide }),
    'textDocument/typeDefinition'
  );
  registerLocationProvider(
    caps.implementationProvider,
    (language, provide) =>
      monaco.languages.registerImplementationProvider(language, { provideImplementation: provide }),
    'textDocument/implementation'
  );
  registerLocationProvider(
    caps.referencesProvider,
    (language, provide) =>
      monaco.languages.registerReferenceProvider(language, {
        provideReferences: (model, position, _context, token) => provide(model, position, token),
      }),
    'textDocument/references',
    { context: { includeDeclaration: true } }
  );

  if (capabilityOn(caps.documentHighlightProvider)) {
    const H = monaco.languages.DocumentHighlightKind;
    const HIGHLIGHT = [H.Text, H.Read, H.Write];
    for (const language of languages) {
      disposables.push(
        monaco.languages.registerDocumentHighlightProvider(language, {
          provideDocumentHighlights: async (model, position, token) => {
            const doc = docOf(model);
            if (!doc) return null;
            const highlights = await ask<LspDocumentHighlight[]>(
              doc,
              'textDocument/documentHighlight',
              { position: toPosition(position) },
              token
            );
            return (highlights ?? []).map((highlight) => ({
              range: toRange(highlight.range),
              kind: HIGHLIGHT[(highlight.kind ?? 1) - 1] ?? H.Text,
            }));
          },
        })
      );
    }
  }

  const formattingOptions = (options: Monaco.languages.FormattingOptions) => ({
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
  });
  if (capabilityOn(caps.documentFormattingProvider)) {
    for (const language of languages) {
      disposables.push(
        monaco.languages.registerDocumentFormattingEditProvider(language, {
          provideDocumentFormattingEdits: async (model, formatting, token) => {
            const doc = docOf(model);
            if (!doc) return null;
            const edits = await ask<LspTextEdit[]>(
              doc,
              'textDocument/formatting',
              { options: formattingOptions(formatting) },
              token
            );
            return (edits ?? []).map(toTextEdit);
          },
        })
      );
    }
  }
  if (capabilityOn(caps.documentRangeFormattingProvider)) {
    for (const language of languages) {
      disposables.push(
        monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
          provideDocumentRangeFormattingEdits: async (model, range, formatting, token) => {
            const doc = docOf(model);
            if (!doc) return null;
            const edits = await ask<LspTextEdit[]>(
              doc,
              'textDocument/rangeFormatting',
              { range: fromRange(range), options: formattingOptions(formatting) },
              token
            );
            return (edits ?? []).map(toTextEdit);
          },
        })
      );
    }
  }

  if (capabilityOn(caps.codeActionProvider)) {
    const resolves =
      typeof caps.codeActionProvider === 'object' &&
      caps.codeActionProvider.resolveProvider === true;
    /** The server's action behind each of Monaco's, for resolve. */
    const originalActions = new WeakMap<Monaco.languages.CodeAction, LspCodeAction>();
    /** A workspace edit the editor can apply: every file loaded as a model, edits mapped. */
    const toWorkspaceEdit = async (
      edit: LspWorkspaceEdit | undefined
    ): Promise<Monaco.languages.WorkspaceEdit | undefined> => {
      if (!edit) return undefined;
      const byUri: { uri: string; edits: LspTextEdit[] }[] = [];
      for (const [uri, edits] of Object.entries(edit.changes ?? {})) byUri.push({ uri, edits });
      for (const change of edit.documentChanges ?? []) {
        if ('textDocument' in change)
          byUri.push({ uri: change.textDocument.uri, edits: change.edits });
      }
      const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
      for (const { uri, edits: textEdits } of byUri) {
        const path = pathForUri(rootUri, uri);
        const model = path === null ? null : await options.loadModel(path);
        if (!model) return undefined; // A file the pane cannot reach: the action is not offered.
        for (const textEdit of textEdits) {
          edits.push({ resource: model.uri, textEdit: toTextEdit(textEdit), versionId: undefined });
        }
      }
      return { edits };
    };
    const isCommand = (
      entry: LspCodeAction | { title: string; command: string }
    ): entry is { title: string; command: string } => typeof entry.command === 'string';
    const toAction = async (
      entry: LspCodeAction | { title: string; command: string }
    ): Promise<Monaco.languages.CodeAction | null> => {
      if (isCommand(entry)) return null; // A bare command: nothing here runs one.
      const edit = await toWorkspaceEdit(entry.edit);
      if (!edit && !resolves) return null;
      const made: Monaco.languages.CodeAction = {
        title: entry.title,
        kind: entry.kind,
        isPreferred: entry.isPreferred,
        disabled: entry.disabled?.reason,
        edit,
      };
      originalActions.set(made, entry);
      return made;
    };
    for (const language of languages) {
      disposables.push(
        monaco.languages.registerCodeActionProvider(language, {
          provideCodeActions: async (model, range, context, token) => {
            const doc = docOf(model);
            if (!doc) return null;
            const wanted = fromRange(range);
            const diagnostics = doc.diagnostics.filter((diagnostic) =>
              overlaps(diagnostic.range, wanted)
            );
            const result = await ask<(LspCodeAction | { title: string; command: string })[]>(
              doc,
              'textDocument/codeAction',
              {
                range: wanted,
                context: { diagnostics, only: context.only ? [context.only] : undefined },
              },
              token
            );
            const actions = await Promise.all((result ?? []).map(toAction));
            return {
              actions: actions.filter(
                (action): action is Monaco.languages.CodeAction => action !== null
              ),
              dispose: () => {},
            };
          },
          resolveCodeAction: resolves
            ? async (action, token) => {
                const original = originalActions.get(action);
                if (!original || action.edit) return action;
                try {
                  const resolved = await client.request<LspCodeAction | null>(
                    'codeAction/resolve',
                    original,
                    token
                  );
                  return { ...action, edit: await toWorkspaceEdit(resolved?.edit) };
                } catch {
                  return action;
                }
              }
            : undefined,
        })
      );
    }
  }

  if (caps.semanticTokensProvider?.full) {
    const legend = caps.semanticTokensProvider.legend;
    for (const language of languages) {
      disposables.push(
        monaco.languages.registerDocumentSemanticTokensProvider(language, {
          getLegend: () => legend,
          provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
            const doc = docOf(model);
            if (!doc) return null;
            const tokens = await ask<LspSemanticTokens>(
              doc,
              'textDocument/semanticTokens/full',
              {},
              token
            );
            if (!tokens) return null;
            return { data: new Uint32Array(tokens.data), resultId: tokens.resultId };
          },
          releaseDocumentSemanticTokens: () => {},
        })
      );
    }
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────

  const S = monaco.MarkerSeverity;
  const SEVERITY = [S.Error, S.Warning, S.Info, S.Hint];
  unsubscribes.push(
    client.onNotification('textDocument/publishDiagnostics', (params) => {
      if (typeof params !== 'object' || params === null || !('uri' in params)) return;
      const { uri } = params;
      const diagnostics: LspDiagnostic[] =
        'diagnostics' in params && Array.isArray(params.diagnostics) ? params.diagnostics : [];
      if (typeof uri !== 'string') return;
      const doc = [...docs.values()].find((entry) => entry.uri === uri);
      if (!doc) return;
      doc.diagnostics = diagnostics;
      monaco.editor.setModelMarkers(
        doc.model,
        owner,
        diagnostics.map((diagnostic) => ({
          ...toRange(diagnostic.range),
          severity: SEVERITY[(diagnostic.severity ?? 1) - 1] ?? S.Error,
          message: diagnostic.message,
          source: diagnostic.source,
          code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
          tags: diagnostic.tags
            ?.map((tag) => (tag === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated))
            .filter((tag) => tag !== undefined),
          relatedInformation: diagnostic.relatedInformation
            ?.map((related) => {
              const path = pathForUri(rootUri, related.location.uri);
              if (path === null) return null;
              return {
                resource: options.modelUriForPath(path),
                message: related.message,
                ...toRange(related.location.range),
              };
            })
            .filter((related): related is Monaco.editor.IRelatedInformation => related !== null),
        }))
      );
    })
  );

  // ─── Documents ─────────────────────────────────────────────────────────

  function syncModel(model: Monaco.editor.ITextModel, path: string, lspLanguageId: string): void {
    const key = model.uri.toString();
    if (docs.has(key)) return;
    const doc: Doc = {
      model,
      path,
      uri: uriForPath(rootUri, path),
      version: 1,
      dirty: false,
      timer: null,
      listener: model.onDidChangeContent(() => {
        doc.dirty = true;
        if (doc.timer) clearTimeout(doc.timer);
        doc.timer = setTimeout(() => flush(doc), CHANGE_DEBOUNCE_MS);
      }),
      diagnostics: [],
    };
    docs.set(key, doc);
    client.notify('textDocument/didOpen', {
      textDocument: { uri: doc.uri, languageId: lspLanguageId, version: 1, text: model.getValue() },
    });
  }

  function release(path: string): void {
    const doc = [...docs.values()].find((entry) => entry.path === path);
    if (!doc) return;
    closeDoc(doc);
  }

  function closeDoc(doc: Doc): void {
    docs.delete(doc.model.uri.toString());
    if (doc.timer) clearTimeout(doc.timer);
    doc.listener.dispose();
    if (!doc.model.isDisposed()) monaco.editor.setModelMarkers(doc.model, owner, []);
    client.notify('textDocument/didClose', { textDocument: textDocument(doc) });
  }

  function saved(path: string): void {
    const doc = [...docs.values()].find((entry) => entry.path === path);
    if (!doc) return;
    flush(doc);
    client.notify('textDocument/didSave', { textDocument: textDocument(doc) });
  }

  return {
    client,
    syncModel,
    release,
    saved,
    covers: (model) => docs.has(model.uri.toString()),
    dispose: () => {
      for (const doc of [...docs.values()]) closeDoc(doc);
      for (const disposable of disposables) disposable.dispose();
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };

  function toTextEdit(edit: LspTextEdit): Monaco.languages.TextEdit {
    return { range: toRange(edit.range), text: edit.newText };
  }
}

function documentationOf(
  value: string | { kind: 'plaintext' | 'markdown'; value: string } | undefined
): Monaco.IMarkdownString | undefined {
  const [text] = markdownOf(value);
  return text ? { value: text } : undefined;
}

function overlaps(a: LspRange, b: LspRange): boolean {
  const before = (x: LspPosition, y: LspPosition) =>
    x.line < y.line || (x.line === y.line && x.character <= y.character);
  return before(a.start, b.end) && before(b.start, a.end);
}
