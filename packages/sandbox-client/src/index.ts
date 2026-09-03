/**
 * The client for the sandbox worker (apps/worker-sandbox) — the ONLY way
 * any other process touches scratch-space bytes. This process holds no
 * scratch disk of its own; the worker resolves every operation against the
 * CALLER's own (tenantId, subject) scope, which is why every function here
 * carries the caller's `subject`.
 *
 * Shared between apps/web (the interactive sandbox_* tools) and apps/worker
 * (the document-ocr-pipeline batch handler staging OCR results) — both need
 * to reach the same isolated worker over the same authenticated HTTP seam.
 *
 * Configuration: SANDBOX_WORKER_URL + SANDBOX_WORKER_API_KEY. Both
 * absent-or-set-together; a missing pair means every operation answers
 * 'unconfigured' — the sandbox is down, never open. The browser verbs
 * (`sbBrowser*`) additionally need SANDBOX_BROWSER_ENABLED on the web side
 * so the sandbox_browser_* tools register only where the worker actually
 * runs a browser — `sandboxBrowserEnabled()` is that check.
 *
 * Errors keep the worker's tag + message so each surface phrases its own
 * refusals; `clientFailure` gives callers one shared status+string mapping
 * so a person and a model hear the same answer.
 */

export interface WireSandboxFile {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  source: string;
  batchId: string | null;
  createdAt: string;
  expiresAt: string;
}

export type SandboxClientError =
  /** SANDBOX_WORKER_URL / _API_KEY are not set. */
  | { kind: 'unconfigured' }
  /** The worker could not be reached or answered garbage. */
  | { kind: 'unreachable'; message: string }
  /** The worker refused or failed the operation; type is the service tag. */
  | { kind: 'op'; type: string; message: string | undefined; status: number };

export type ClientResult<T> = { ok: true; val: T } | { ok: false; err: SandboxClientError };

export interface SandboxTarget {
  tenantId: string;
  subject: string;
}

const REQUEST_TIMEOUT_MS = 90_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function sandboxConfig(): { url: string; key: string } | null {
  const url = process.env.SANDBOX_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.SANDBOX_WORKER_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/**
 * Whether this deployment offers the sandbox browser: the worker must be
 * configured AND SANDBOX_BROWSER_ENABLED set (the same flag the worker
 * reads to launch one). Off unless said otherwise — closed, never open.
 */
export function sandboxBrowserEnabled(): boolean {
  if (!sandboxConfig()) return false;
  return /^(1|true|yes|on)$/i.test((process.env.SANDBOX_BROWSER_ENABLED ?? '').trim());
}

function unreachable(message: string): { ok: false; err: SandboxClientError } {
  return { ok: false, err: { kind: 'unreachable', message } };
}

async function opFailure(response: Response): Promise<{ ok: false; err: SandboxClientError }> {
  let type = 'internal';
  let message: string | undefined;
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed) && isRecord(parsed.error)) {
      type = str(parsed.error.type) || 'internal';
      message = optStr(parsed.error.message);
    }
  } catch {
    // A non-JSON failure body: keep the generic tag.
  }
  return { ok: false, err: { kind: 'op', type, message, status: response.status } };
}

async function callOp(op: string, body: unknown): Promise<ClientResult<Response>> {
  const cfg = sandboxConfig();
  if (!cfg) return { ok: false, err: { kind: 'unconfigured' } };
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return opFailure(response);
  return { ok: true, val: response };
}

async function callJson(op: string, body: unknown): Promise<ClientResult<unknown>> {
  const called = await callOp(op, body);
  if (!called.ok) return called;
  try {
    return { ok: true, val: await called.val.json() };
  } catch {
    return unreachable('The sandbox service answered an unreadable response.');
  }
}

function malformed<T>(): ClientResult<T> {
  return {
    ok: false,
    err: { kind: 'unreachable', message: 'The sandbox service answered an unexpected shape.' },
  };
}

function fileOf(value: unknown): WireSandboxFile | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const filename = str(value.filename);
  const createdAt = str(value.createdAt);
  const expiresAt = str(value.expiresAt);
  if (!id || !filename || !createdAt || !expiresAt) return null;
  return {
    id,
    filename,
    contentType: optStr(value.contentType) ?? null,
    sizeBytes: typeof value.sizeBytes === 'number' ? value.sizeBytes : 0,
    source: str(value.source),
    batchId: optStr(value.batchId) ?? null,
    createdAt,
    expiresAt,
  };
}

export async function sbFetchUrl(
  target: SandboxTarget,
  input: { url: string; filename: string; contentType?: string; batchId?: string }
): Promise<ClientResult<WireSandboxFile>> {
  const result = await callJson('fetch', { ...target, ...input });
  if (!result.ok) return result;
  const file = fileOf(result.val);
  return file ? { ok: true, val: file } : malformed();
}

export async function sbListFiles(
  target: SandboxTarget,
  batchId?: string
): Promise<ClientResult<WireSandboxFile[]>> {
  const result = await callJson('list', { ...target, ...(batchId ? { batchId } : {}) });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || !Array.isArray(value.files)) return malformed();
  const files: WireSandboxFile[] = [];
  for (const raw of value.files) {
    const file = fileOf(raw);
    if (!file) return malformed();
    files.push(file);
  }
  return { ok: true, val: files };
}

export async function sbStatFile(
  target: SandboxTarget,
  fileId: string
): Promise<ClientResult<{ id: string; filename: string; contentType: string | null }>> {
  const result = await callJson('stat', { ...target, fileId });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const id = str(value.id);
  const filename = str(value.filename);
  if (!id || !filename) return malformed();
  return { ok: true, val: { id, filename, contentType: optStr(value.contentType) ?? null } };
}

export interface SandboxFileBytes {
  filename: string;
  contentType: string | null;
  bytes: Uint8Array;
}

export async function sbReadFile(
  target: SandboxTarget,
  fileId: string
): Promise<ClientResult<SandboxFileBytes>> {
  const called = await callOp('read', { ...target, fileId });
  if (!called.ok) return called;
  try {
    const filenameHeader = called.val.headers.get('x-sandbox-filename');
    const filename = filenameHeader ? decodeURIComponent(filenameHeader) : 'file';
    const contentType = called.val.headers.get('content-type');
    const bytes = new Uint8Array(await called.val.arrayBuffer());
    return { ok: true, val: { filename, contentType, bytes } };
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
}

export async function sbWriteFile(
  target: SandboxTarget,
  input: { filename: string; contentType?: string; source?: string; batchId?: string },
  bytes: Uint8Array
): Promise<ClientResult<WireSandboxFile>> {
  const cfg = sandboxConfig();
  if (!cfg) return { ok: false, err: { kind: 'unconfigured' } };
  const query = new URLSearchParams({
    tenantId: target.tenantId,
    subject: target.subject,
    filename: input.filename,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
  });
  // Copy into a plain ArrayBuffer: BodyInit does not accept a view over a
  // possibly-shared buffer, and the copy is bounded by the org's upload cap.
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/write?${query.toString()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/octet-stream' },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return opFailure(response);
  try {
    const parsed: unknown = await response.json();
    const file = fileOf(parsed);
    return file ? { ok: true, val: file } : malformed();
  } catch {
    return malformed();
  }
}

export async function sbDeleteFile(
  target: SandboxTarget,
  fileId: string
): Promise<ClientResult<{ id: string }>> {
  const result = await callJson('delete', { ...target, fileId });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || !value.deleted) return malformed();
  return { ok: true, val: { id: str(value.id) } };
}

// ─── The browser ────────────────────────────────────────────────────────────

/** Where a browser session's page is after a verb, and what is on it. */
export interface WireBrowserPage {
  url: string;
  title: string;
  /** The rendered snapshot — headings, text, and [eN]-ref'd interactive elements. */
  snapshot: string;
  truncated: boolean;
}

function browserPageOf(value: unknown): WireBrowserPage | null {
  if (!isRecord(value)) return null;
  const url = str(value.url);
  const snapshot = str(value.snapshot);
  if (!url || typeof value.snapshot !== 'string') return null;
  return { url, title: str(value.title), snapshot, truncated: value.truncated === true };
}

async function browserPageCall(
  op: string,
  target: SandboxTarget,
  input: Record<string, unknown>
): Promise<ClientResult<WireBrowserPage>> {
  const result = await callJson(`browser/${op}`, { ...target, ...input });
  if (!result.ok) return result;
  const page = browserPageOf(result.val);
  return page ? { ok: true, val: page } : malformed();
}

export async function sbBrowserStatus(): Promise<ClientResult<{ enabled: boolean; sessions: number }>> {
  const result = await callJson('browser/status', {});
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return malformed();
  return {
    ok: true,
    val: { enabled: value.enabled, sessions: typeof value.sessions === 'number' ? value.sessions : 0 },
  };
}

export function sbBrowserNavigate(
  target: SandboxTarget,
  input: { url: string; maxChars?: number }
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('navigate', target, input);
}

export function sbBrowserSnapshot(
  target: SandboxTarget,
  input: { maxChars?: number } = {}
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('snapshot', target, input);
}

export function sbBrowserClick(
  target: SandboxTarget,
  input: { ref: string; maxChars?: number }
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('click', target, input);
}

export function sbBrowserType(
  target: SandboxTarget,
  input: { ref: string; text: string; submit?: boolean; maxChars?: number }
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('type', target, input);
}

export function sbBrowserSelect(
  target: SandboxTarget,
  input: { ref: string; values: string[]; maxChars?: number }
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('select', target, input);
}

export function sbBrowserPress(
  target: SandboxTarget,
  input: { key: string; maxChars?: number }
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('press', target, input);
}

export function sbBrowserBack(
  target: SandboxTarget,
  input: { maxChars?: number } = {}
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('back', target, input);
}

export async function sbBrowserScreenshot(
  target: SandboxTarget,
  input: { fullPage?: boolean; filename?: string } = {}
): Promise<ClientResult<{ file: WireSandboxFile; url: string; title: string }>> {
  const result = await callJson('browser/screenshot', { ...target, ...input });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const file = fileOf(value.file);
  if (!file) return malformed();
  return { ok: true, val: { file, url: str(value.url), title: str(value.title) } };
}

export async function sbBrowserClose(target: SandboxTarget): Promise<ClientResult<{ closed: boolean }>> {
  const result = await callJson('browser/close', { ...target });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.closed !== 'boolean') return malformed();
  return { ok: true, val: { closed: value.closed } };
}

/**
 * One shared mapping from a client error to a model-facing refusal, so
 * every sandbox_* tool and every batch-pipeline caller phrases the same
 * failure the same way.
 */
export function clientFailure(error: SandboxClientError): { status: number; message: string } {
  if (error.kind === 'unconfigured') {
    return { status: 503, message: 'The sandbox scratch space is not configured on this deployment.' };
  }
  if (error.kind === 'unreachable') {
    return { status: 502, message: 'Could not reach the sandbox service.' };
  }
  switch (error.type) {
    case 'not_found':
      return { status: 404, message: 'No such staged file (it may have expired).' };
    case 'blocked_url':
      return { status: 400, message: error.message ?? 'That URL is not allowed.' };
    case 'too_large':
      return { status: 413, message: error.message ?? 'That file is too large to stage.' };
    case 'quota_exceeded':
      return {
        status: 429,
        message: error.message ?? 'The scratch space quota is full — delete a staged file first.',
      };
    case 'fetch_failed':
      return { status: 502, message: error.message ?? 'Could not fetch that URL.' };
    case 'bad_filename':
      return { status: 400, message: 'That filename is not usable — no path separators.' };
    case 'browser_unavailable':
      return {
        status: 503,
        message: error.message ?? 'The sandbox browser is not enabled on this deployment.',
      };
    case 'no_session':
      return {
        status: 409,
        message: error.message ?? 'No page is open — open one with sandbox_browser_navigate first.',
      };
    case 'bad_ref':
      return { status: 400, message: error.message ?? 'That ref is not on the current page — take a new snapshot.' };
    case 'navigation_failed':
      return { status: 502, message: error.message ?? 'The browser could not load that page.' };
    case 'action_failed':
      return { status: 400, message: error.message ?? 'The browser could not perform that action.' };
    default:
      return { status: error.status, message: error.message ?? error.type };
  }
}
