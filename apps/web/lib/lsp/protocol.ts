/**
 * The slice of the Language Server Protocol the code pane's editor
 * speaks, typed as the wire has it, and the mapping between a checkout
 * path and the URI a server knows it by. The conversions to Monaco's
 * own shapes live in monaco.ts; nothing here imports Monaco.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

export interface LspMarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}

export type LspMarkedString = string | { language: string; value: string };

export interface LspDiagnostic {
  range: LspRange;
  /** 1 error, 2 warning, 3 information, 4 hint. */
  severity?: 1 | 2 | 3 | 4;
  code?: number | string;
  source?: string;
  message: string;
  /** 1 unnecessary, 2 deprecated. */
  tags?: number[];
  relatedInformation?: { location: LspLocation; message: string }[];
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspInsertReplaceEdit {
  newText: string;
  insert: LspRange;
  replace: LspRange;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 1 plain text, 2 snippet. */
  insertTextFormat?: 1 | 2;
  textEdit?: LspTextEdit | LspInsertReplaceEdit;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  tags?: number[];
  data?: unknown;
}

export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[];
  range?: LspRange;
}

export interface LspParameterInformation {
  label: string | [number, number];
  documentation?: string | LspMarkupContent;
}

export interface LspSignatureInformation {
  label: string;
  documentation?: string | LspMarkupContent;
  parameters?: LspParameterInformation[];
  activeParameter?: number;
}

export interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface LspDocumentHighlight {
  range: LspRange;
  kind?: 1 | 2 | 3;
}

export interface LspSemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface LspSemanticTokens {
  resultId?: string;
  data: number[];
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: LspWorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
  data?: unknown;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: (
    | { textDocument: { uri: string; version?: number | null }; edits: LspTextEdit[] }
    | { kind: string }
  )[];
}

/** What a server says it can do, in the fields the editor reads; the rest rides along. */
export interface LspServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | object };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: boolean | object;
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentHighlightProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
  semanticTokensProvider?: {
    legend: LspSemanticTokensLegend;
    full?: boolean | { delta?: boolean };
    range?: boolean | object;
  };
  [other: string]: unknown;
}

export function capabilityOn(value: unknown): boolean {
  return value === true || (typeof value === 'object' && value !== null);
}

// ─── Paths and URIs ─────────────────────────────────────────────────────────

/** A checkout path as the server names it: under the session's root, each segment encoded. */
export function uriForPath(rootUri: string, path: string): string {
  return `${rootUri}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The checkout path a server's URI names, or null for one outside the checkout (or not a file). */
export function pathForUri(rootUri: string, uri: string): string | null {
  const root = `${rootUri}/`;
  if (!uri.startsWith(root)) return null;
  try {
    return uri.slice(root.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

/** The text of a hover or a documentation field, as Markdown. */
export function markdownOf(
  contents: LspHover['contents'] | string | LspMarkupContent | undefined
): string[] {
  if (contents === undefined || contents === null) return [];
  const one = (entry: LspMarkedString | LspMarkupContent): string => {
    if (typeof entry === 'string') return entry;
    if ('kind' in entry) {
      return entry.kind === 'markdown' ? entry.value : fence('', entry.value);
    }
    return fence(entry.language, entry.value);
  };
  return (Array.isArray(contents) ? contents : [contents]).map(one).filter(Boolean);
}

function fence(language: string, value: string): string {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}
