/**
 * Language servers for the code pane — the pure half. Which servers the
 * sandbox image is expected to carry and how each is started, which
 * editor languages each one takes, the bounds a session lives under, and
 * the check every message the browser sends a server goes through.
 *
 * The shape: the worker runs one server process per (checkout, server,
 * editor) as the checkout's own uid, speaks JSON-RPC to it over stdio,
 * and relays the messages to the browser — the browser's Monaco is the
 * language client. The worker owns the lifecycle (`initialize`,
 * `shutdown`, `exit`) so a client can neither re-initialise a server
 * against another root nor leave one hanging; everything else is the
 * protocol as the server and the editor understand it.
 *
 * Nothing here touches disk or a process (apps/worker-sandbox's
 * lsp-sessions.ts does); the web app and the worker share this so a
 * refused message is refused the same way on both sides.
 */

/** A server the image may carry; `lsp/languages` says which ones this worker actually has. */
export interface LanguageServerSpec {
  /** The id the wire and the pane use. */
  id: LanguageServerId;
  /** What the status line calls it. */
  label: string;
  /** The Monaco language ids this server takes (the pane's `languageForPath`). */
  languages: readonly string[];
  /** The executable, looked up on the caller's PATH; absent means the language has no server here. */
  command: string;
  /** Its arguments; `${HOME}` and `${SESSION}` are filled per session (`serverArgs`). */
  args: readonly string[];
}

export const LANGUAGE_SERVER_IDS = [
  'typescript',
  'python',
  'java',
  'sql',
  'clangd',
  'go',
  'rust',
  'r',
  'bash',
] as const;

export type LanguageServerId = (typeof LANGUAGE_SERVER_IDS)[number];

export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [
  {
    id: 'typescript',
    label: 'TypeScript',
    languages: ['typescript', 'javascript'],
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  {
    id: 'python',
    label: 'Pyright',
    languages: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
  },
  {
    id: 'java',
    label: 'Eclipse JDT',
    languages: ['java'],
    command: 'jdtls',
    // Its index and metadata live under the caller's own cache, one
    // directory per session, never in the checkout.
    args: ['-data', '${HOME}/.cache/jdtls/${SESSION}'],
  },
  {
    id: 'sql',
    label: 'SQL',
    languages: ['sql', 'pgsql', 'mysql'],
    command: 'sql-language-server',
    args: ['up', '--method', 'stdio'],
  },
  {
    id: 'clangd',
    label: 'clangd',
    languages: ['c', 'cpp'],
    command: 'clangd',
    args: ['--background-index', '--log=error'],
  },
  { id: 'go', label: 'gopls', languages: ['go'], command: 'gopls', args: [] },
  { id: 'rust', label: 'rust-analyzer', languages: ['rust'], command: 'rust-analyzer', args: [] },
  {
    id: 'r',
    label: 'R',
    languages: ['r'],
    command: 'R',
    args: ['--slave', '-e', 'languageserver::run()'],
  },
  {
    id: 'bash',
    label: 'Bash',
    languages: ['shell'],
    command: 'bash-language-server',
    args: ['start'],
  },
];

export function isLanguageServerId(value: unknown): value is LanguageServerId {
  return LANGUAGE_SERVER_IDS.some((id) => id === value);
}

export function languageServerSpec(id: LanguageServerId): LanguageServerSpec {
  return LANGUAGE_SERVERS.find((spec) => spec.id === id)!;
}

/** The server that takes a Monaco language, or null when none is defined for it. */
export function languageServerFor(monacoLanguage: string): LanguageServerSpec | null {
  return LANGUAGE_SERVERS.find((spec) => spec.languages.includes(monacoLanguage)) ?? null;
}

/**
 * The protocol's own language id for a file, which is finer than
 * Monaco's: a `.tsx` is `typescriptreact` to a TypeScript server, and a
 * server told `typescript` for it parses the JSX as type assertions.
 */
export function lspLanguageIdFor(path: string, monacoLanguage: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'typescriptreact';
  if (lower.endsWith('.jsx')) return 'javascriptreact';
  if (monacoLanguage === 'pgsql' || monacoLanguage === 'mysql') return 'sql';
  return monacoLanguage;
}

/** A server's arguments with the per-session values filled in. */
export function serverArgs(
  spec: LanguageServerSpec,
  values: { home: string; session: string }
): string[] {
  return spec.args.map((arg) =>
    arg.replaceAll('${HOME}', values.home).replaceAll('${SESSION}', values.session)
  );
}

// ─── Bounds ────────────────────────────────────────────────────────────────

/** Servers one checkout may have running at once (across its editors and languages). */
export const LSP_MAX_SESSIONS_PER_WORKSPACE = 6;
/** Servers one worker may have running at once, all checkouts together. */
export const LSP_MAX_SESSIONS = 48;
/** A session nobody has spoken to or listened on for this long is shut down. */
export const LSP_IDLE_MS = 10 * 60_000;
/** How long `initialize` may take: a Java server indexing a large tree needs most of this. */
export const LSP_INIT_TIMEOUT_MS = 90_000;
/** One message either way; a whole-file `didChange` of the largest editable file fits with room. */
export const LSP_MESSAGE_MAX_BYTES = 4 * 1_048_576;
/** Messages a server produced while no editor was listening; beyond this the oldest go. */
export const LSP_BUFFER_MAX_MESSAGES = 2_000;
/** An editor's own id for its sessions, so a second tab of the same chat gets servers of its own. */
export const LSP_CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// ─── Messages ──────────────────────────────────────────────────────────────

/** Methods the worker alone sends: a client that could send them could re-root or orphan a server. */
const LIFECYCLE_METHODS = new Set([
  'initialize',
  'initialized',
  'shutdown',
  'exit',
  'workspace/didChangeWorkspaceFolders',
]);

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every file URI a message names, however the method nests it: the
 * document of a request, the target of a rename, a related location.
 */
export function fileUrisIn(value: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 12) return found;
  if (Array.isArray(value)) {
    for (const entry of value) fileUrisIn(entry, found, depth + 1);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (
        (key === 'uri' || key === 'targetUri' || key === 'oldUri' || key === 'newUri') &&
        typeof entry === 'string'
      ) {
        found.push(entry);
      } else {
        fileUrisIn(entry, found, depth + 1);
      }
    }
  }
  return found;
}

/** Whether a `file:` URI names something inside the checkout at `rootUri` (no `..`, no other root). */
export function uriInsideRoot(uri: string, rootUri: string): boolean {
  if (!uri.startsWith('file://')) return true; // Not a file at all: a server's own scheme, left to it.
  const root = rootUri.endsWith('/') ? rootUri : `${rootUri}/`;
  if (uri !== rootUri && !uri.startsWith(root)) return false;
  const path = uri.slice(root.length);
  return !path
    .split('/')
    .some((segment) => segment === '..' || segment === '%2E%2E' || segment === '%2e%2e');
}

/**
 * A message the browser wants sent to a server: a JSON-RPC 2.0 request,
 * notification or response, not a lifecycle method, naming no file
 * outside the checkout. The message is the client's business otherwise;
 * a method the server does not know earns the server's own error back.
 */
export function validateClientMessage(
  value: unknown,
  rootUri: string
): { ok: true; message: JsonRpcMessage } | { ok: false; message: string } {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    return { ok: false, message: 'A message is a JSON-RPC 2.0 object.' };
  }
  const method = value.method;
  const hasId = 'id' in value && value.id !== undefined;
  const isResponse = method === undefined && hasId && ('result' in value || 'error' in value);
  if (method !== undefined) {
    if (typeof method !== 'string' || !method) {
      return { ok: false, message: 'A method is a non-empty string.' };
    }
    if (LIFECYCLE_METHODS.has(method)) {
      return { ok: false, message: `${method} is the worker’s to send, not the editor’s.` };
    }
    if (hasId && typeof value.id !== 'number' && typeof value.id !== 'string') {
      return { ok: false, message: 'A request id is a number or a string.' };
    }
  } else if (!isResponse) {
    return { ok: false, message: 'A message is a request, a notification or a response.' };
  }
  const id = value.id;
  if (id !== undefined && id !== null && typeof id !== 'number' && typeof id !== 'string') {
    return { ok: false, message: 'A message id is a number, a string or null.' };
  }
  const outside = fileUrisIn(value.params ?? value.result).find(
    (uri) => !uriInsideRoot(uri, rootUri)
  );
  if (outside) {
    return { ok: false, message: `${outside} is outside the checkout.` };
  }
  // Rebuilt field by field, typed, rather than the wire object trusted whole.
  const message: JsonRpcMessage = { jsonrpc: '2.0' };
  if (id !== undefined) message.id = id;
  if (typeof method === 'string') message.method = method;
  if ('params' in value) message.params = value.params;
  if ('result' in value) message.result = value.result;
  if ('error' in value) message.error = value.error;
  return { ok: true, message };
}
