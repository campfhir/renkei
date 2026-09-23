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

/**
 * Whether this deployment offers code workspaces: the worker must be
 * configured AND SANDBOX_WORKSPACES_ENABLED set (the same flag the worker
 * reads to serve them). Off unless said otherwise — closed, never open.
 */
export function sandboxWorkspacesEnabled(): boolean {
  if (!sandboxConfig()) return false;
  return /^(1|true|yes|on)$/i.test((process.env.SANDBOX_WORKSPACES_ENABLED ?? '').trim());
}

/**
 * Whether this deployment offers code project services — containers
 * started beside a checkout: workspaces must be on AND
 * SANDBOX_SERVICES_ENABLED set (the same flag the worker reads to talk
 * to its Docker engine). Off unless said otherwise — closed, never open.
 */
export function sandboxServicesEnabled(): boolean {
  if (!sandboxWorkspacesEnabled()) return false;
  return /^(1|true|yes|on)$/i.test((process.env.SANDBOX_SERVICES_ENABLED ?? '').trim());
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

export async function sbBrowserStatus(): Promise<
  ClientResult<{ enabled: boolean; sessions: number }>
> {
  const result = await callJson('browser/status', {});
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return malformed();
  return {
    ok: true,
    val: {
      enabled: value.enabled,
      sessions: typeof value.sessions === 'number' ? value.sessions : 0,
    },
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

/** A type step's secret reference: which stored secret, which field — never a value. */
export interface WireSecretRef {
  name: string;
  field: string;
}

export function sbBrowserType(
  target: SandboxTarget,
  input: { ref: string; text?: string; secret?: WireSecretRef; submit?: boolean; maxChars?: number }
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

export function sbBrowserScroll(
  target: SandboxTarget,
  input: { ref?: string; direction?: 'up' | 'down'; amount?: number; maxChars?: number } = {}
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('scroll', target, input);
}

export function sbBrowserBack(
  target: SandboxTarget,
  input: { maxChars?: number } = {}
): Promise<ClientResult<WireBrowserPage>> {
  return browserPageCall('back', target, input);
}

/**
 * One step of a sandbox_browser_run, as the wire carries it — the same
 * shape @renkei/connector-sandbox's `BrowserStep` validates on the worker,
 * spelled out here so this dependency-free package needs no import for it.
 */
export type WireBrowserStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text?: string; secret?: WireSecretRef; submit?: boolean }
  | { kind: 'select'; ref: string; values: string[] }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; ref?: string; direction?: 'up' | 'down'; amount?: number }
  | { kind: 'wait'; ms?: number; text?: string }
  | { kind: 'back' };

/** How far a run got, the page it ended on, and what stopped it. */
export interface WireBrowserRun {
  completed: number;
  page: WireBrowserPage | null;
  failed: { index: number; kind: string; type: string; message: string } | null;
}

export async function sbBrowserRun(
  target: SandboxTarget,
  input: { steps: WireBrowserStep[]; maxChars?: number }
): Promise<ClientResult<WireBrowserRun>> {
  const result = await callJson('browser/run', { ...target, ...input });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.completed !== 'number') return malformed();
  const page = value.page === null || value.page === undefined ? null : browserPageOf(value.page);
  if (value.page && !page) return malformed();
  let failed: WireBrowserRun['failed'] = null;
  if (isRecord(value.failed)) {
    if (typeof value.failed.index !== 'number') return malformed();
    failed = {
      index: value.failed.index,
      kind: str(value.failed.kind),
      type: str(value.failed.type) || 'action_failed',
      message: str(value.failed.message),
    };
  }
  return { ok: true, val: { completed: value.completed, page, failed } };
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

export async function sbBrowserClose(
  target: SandboxTarget
): Promise<ClientResult<{ closed: boolean }>> {
  const result = await callJson('browser/close', { ...target });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.closed !== 'boolean') return malformed();
  return { ok: true, val: { closed: value.closed } };
}

// ─── Browser secrets ────────────────────────────────────────────────────────

/** One secret as the worker describes it: never a value, never the passphrase. */
export interface WireSandboxSecret {
  id: string;
  name: string;
  fields: string[];
  hosts: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** ISO time the worker's in-memory key lapses; null when locked. */
  unlockedUntil: string | null;
}

function secretOf(value: unknown): WireSandboxSecret | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  const createdAt = str(value.createdAt);
  const expiresAt = str(value.expiresAt);
  if (!id || !name || !createdAt || !expiresAt) return null;
  const list = (raw: unknown) =>
    Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    id,
    name,
    fields: list(value.fields),
    hosts: list(value.hosts),
    createdAt,
    expiresAt,
    lastUsedAt: optStr(value.lastUsedAt) ?? null,
    unlockedUntil: optStr(value.unlockedUntil) ?? null,
  };
}

async function secretCall(
  op: string,
  target: SandboxTarget,
  input: Record<string, unknown>
): Promise<ClientResult<WireSandboxSecret>> {
  const result = await callJson(`secrets/${op}`, { ...target, ...input });
  if (!result.ok) return result;
  const value = result.val;
  const secret = isRecord(value) ? secretOf(value.secret) : null;
  return secret ? { ok: true, val: secret } : malformed();
}

/**
 * Seal a new secret on the worker. The passphrase is optional: absent, the
 * worker generates one and returns it HERE, once — the only time any
 * Renkei response ever carries it. The values travel to the worker over
 * the internal seam and nowhere else.
 */
export async function sbSecretCreate(
  target: SandboxTarget,
  input: {
    name: string;
    fields: Record<string, string>;
    hosts: string[];
    passphrase?: string;
    unlockMs?: number;
    ttlMs?: number;
  }
): Promise<ClientResult<{ secret: WireSandboxSecret; passphrase: string | null }>> {
  const result = await callJson('secrets/create', { ...target, ...input });
  if (!result.ok) return result;
  const value = result.val;
  const secret = isRecord(value) ? secretOf(value.secret) : null;
  if (!secret || !isRecord(value)) return malformed();
  return { ok: true, val: { secret, passphrase: optStr(value.passphrase) ?? null } };
}

export async function sbSecretsList(
  target: SandboxTarget
): Promise<ClientResult<WireSandboxSecret[]>> {
  const result = await callJson('secrets/list', { ...target });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || !Array.isArray(value.secrets)) return malformed();
  const secrets: WireSandboxSecret[] = [];
  for (const raw of value.secrets) {
    const secret = secretOf(raw);
    if (!secret) return malformed();
    secrets.push(secret);
  }
  return { ok: true, val: secrets };
}

export function sbSecretUnlock(
  target: SandboxTarget,
  input: { id: string; passphrase: string; unlockMs?: number }
): Promise<ClientResult<WireSandboxSecret>> {
  return secretCall('unlock', target, input);
}

export function sbSecretLock(
  target: SandboxTarget,
  id: string
): Promise<ClientResult<WireSandboxSecret>> {
  return secretCall('lock', target, { id });
}

export async function sbSecretRevoke(
  target: SandboxTarget,
  id: string
): Promise<ClientResult<{ id: string; name: string }>> {
  const result = await callJson('secrets/revoke', { ...target, id });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || !value.revoked) return malformed();
  return { ok: true, val: { id: str(value.id), name: str(value.name) } };
}

// ─── Code workspaces ────────────────────────────────────────────────────────

/** One workspace as the worker describes it — dates as ISO strings. */
export interface WireWorkspace {
  id: string;
  provider: string;
  repoFullName: string;
  branch: string;
  status: 'cloning' | 'ready' | 'failed';
  error: string | null;
  sizeBytes: number;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** The worker instance that answered, when it says; two of them behind one address is a deployment fault this makes visible. */
  worker: string | null;
}

function workspaceOf(value: unknown): WireWorkspace | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const repoFullName = str(value.repoFullName);
  const status = str(value.status);
  if (!id || !repoFullName || (status !== 'cloning' && status !== 'ready' && status !== 'failed')) {
    return null;
  }
  return {
    id,
    provider: str(value.provider),
    repoFullName,
    branch: str(value.branch),
    status,
    error: optStr(value.error) ?? null,
    sizeBytes: typeof value.sizeBytes === 'number' ? value.sizeBytes : 0,
    createdAt: str(value.createdAt),
    lastUsedAt: str(value.lastUsedAt),
    expiresAt: str(value.expiresAt),
    worker: optStr(value.worker) ?? null,
  };
}

async function workspaceCall(
  op: string,
  target: SandboxTarget,
  input: Record<string, unknown>
): Promise<ClientResult<unknown>> {
  return callJson(`workspaces/${op}`, { ...target, ...input });
}

/**
 * Start a clone. The worker answers at once with the row in `cloning`;
 * the clone itself runs on the worker, and `sbWorkspaceGet`/`sbWorkspaceList`
 * report when it is `ready` (or `failed`, with why). `authHeader` is the
 * git Authorization header for the one clone — built by the caller from
 * the person's own grant, forwarded once, kept nowhere.
 */
export async function sbWorkspaceClone(
  target: SandboxTarget,
  input: {
    provider: string;
    repoFullName: string;
    branch?: string;
    depth?: number;
    cloneUrl: string;
    authHeader: string;
  }
): Promise<ClientResult<WireWorkspace>> {
  const result = await workspaceCall('clone', target, input);
  if (!result.ok) return result;
  const workspace = isRecord(result.val) ? workspaceOf(result.val.workspace) : null;
  return workspace ? { ok: true, val: workspace } : malformed();
}

export async function sbWorkspaceList(
  target: SandboxTarget
): Promise<ClientResult<WireWorkspace[]>> {
  const result = await workspaceCall('list', target, {});
  if (!result.ok) return result;
  if (!isRecord(result.val) || !Array.isArray(result.val.workspaces)) return malformed();
  const workspaces: WireWorkspace[] = [];
  for (const raw of result.val.workspaces) {
    const workspace = workspaceOf(raw);
    if (!workspace) return malformed();
    workspaces.push(workspace);
  }
  return { ok: true, val: workspaces };
}

export async function sbWorkspaceGet(
  target: SandboxTarget,
  id: string
): Promise<ClientResult<WireWorkspace>> {
  const result = await workspaceCall('get', target, { id });
  if (!result.ok) return result;
  const workspace = isRecord(result.val) ? workspaceOf(result.val.workspace) : null;
  return workspace ? { ok: true, val: workspace } : malformed();
}

export async function sbWorkspaceDelete(
  target: SandboxTarget,
  id: string
): Promise<ClientResult<{ id: string; repoFullName: string }>> {
  const result = await workspaceCall('delete', target, { id });
  if (!result.ok) return result;
  if (!isRecord(result.val) || !result.val.deleted) return malformed();
  return { ok: true, val: { id: str(result.val.id), repoFullName: str(result.val.repoFullName) } };
}

export interface WireFileEntry {
  path: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  sizeBytes: number | null;
}

export async function sbWorkspaceLs(
  target: SandboxTarget,
  input: { id: string; path?: string }
): Promise<ClientResult<{ path: string; entries: WireFileEntry[] }>> {
  const result = await workspaceCall('ls', target, input);
  if (!result.ok) return result;
  if (!isRecord(result.val) || !Array.isArray(result.val.entries)) return malformed();
  const entries: WireFileEntry[] = [];
  for (const raw of result.val.entries) {
    if (!isRecord(raw)) return malformed();
    const kind = str(raw.kind);
    entries.push({
      path: str(raw.path),
      kind: kind === 'file' || kind === 'dir' || kind === 'link' ? kind : 'other',
      sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : null,
    });
  }
  return { ok: true, val: { path: str(result.val.path), entries } };
}

export async function sbWorkspaceFind(
  target: SandboxTarget,
  input: { id: string; glob?: string; max?: number }
): Promise<ClientResult<{ paths: string[]; truncated: boolean }>> {
  const result = await workspaceCall('find', target, input);
  if (!result.ok) return result;
  if (!isRecord(result.val) || !Array.isArray(result.val.paths)) return malformed();
  return {
    ok: true,
    val: {
      paths: result.val.paths.filter((entry): entry is string => typeof entry === 'string'),
      truncated: result.val.truncated === true,
    },
  };
}

export interface WireGrepMatch {
  path: string;
  line: number;
  text: string;
}

export async function sbWorkspaceGrep(
  target: SandboxTarget,
  input: {
    id: string;
    pattern: string;
    path?: string;
    glob?: string;
    caseInsensitive?: boolean;
    fixedStrings?: boolean;
    max?: number;
  }
): Promise<ClientResult<{ matches: WireGrepMatch[]; truncated: boolean }>> {
  const result = await workspaceCall('grep', target, input);
  if (!result.ok) return result;
  if (!isRecord(result.val) || !Array.isArray(result.val.matches)) return malformed();
  const matches: WireGrepMatch[] = [];
  for (const raw of result.val.matches) {
    if (!isRecord(raw)) return malformed();
    matches.push({
      path: str(raw.path),
      line: typeof raw.line === 'number' ? raw.line : 0,
      text: str(raw.text),
    });
  }
  return { ok: true, val: { matches, truncated: result.val.truncated === true } };
}

export interface WireFileText {
  path: string;
  text: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
}

export async function sbWorkspaceRead(
  target: SandboxTarget,
  input: { id: string; path: string; startLine?: number; maxLines?: number }
): Promise<ClientResult<WireFileText>> {
  const result = await workspaceCall('read', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.text !== 'string') return malformed();
  const num = (raw: unknown) => (typeof raw === 'number' ? raw : 0);
  return {
    ok: true,
    val: {
      path: str(value.path),
      text: value.text,
      sizeBytes: num(value.sizeBytes),
      totalLines: num(value.totalLines),
      startLine: num(value.startLine),
      endLine: num(value.endLine),
    },
  };
}

export async function sbWorkspaceWrite(
  target: SandboxTarget,
  input: { id: string; path: string; content: string }
): Promise<ClientResult<{ path: string; created: boolean; sizeBytes: number }>> {
  const result = await workspaceCall('write', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  return {
    ok: true,
    val: {
      path: str(value.path),
      created: value.created === true,
      sizeBytes: typeof value.sizeBytes === 'number' ? value.sizeBytes : 0,
    },
  };
}

/**
 * A file uploaded into the checkout as bytes — a person's gesture from the
 * project page, not the model's. The body is the file; the target, the
 * workspace and the destination path ride the query string.
 */
export async function sbWorkspaceUpload(
  target: SandboxTarget,
  input: { id: string; path: string; bytes: Uint8Array<ArrayBuffer> }
): Promise<ClientResult<{ path: string; created: boolean; sizeBytes: number }>> {
  const cfg = sandboxConfig();
  if (!cfg) return { ok: false, err: { kind: 'unconfigured' } };
  const query = new URLSearchParams({
    tenantId: target.tenantId,
    subject: target.subject,
    id: input.id,
    path: input.path,
  });
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/workspaces/upload?${query.toString()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/octet-stream' },
      body: input.bytes,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return opFailure(response);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return unreachable('The sandbox service answered an unreadable response.');
  }
  if (!isRecord(value)) return malformed();
  return {
    ok: true,
    val: {
      path: str(value.path),
      created: value.created === true,
      sizeBytes: typeof value.sizeBytes === 'number' ? value.sizeBytes : 0,
    },
  };
}

export async function sbWorkspaceEdit(
  target: SandboxTarget,
  input: { id: string; path: string; oldText: string; newText: string; replaceAll?: boolean }
): Promise<ClientResult<{ path: string; replacements: number }>> {
  const result = await workspaceCall('edit', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  return {
    ok: true,
    val: {
      path: str(value.path),
      replacements: typeof value.replacements === 'number' ? value.replacements : 0,
    },
  };
}

export interface WireExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  timeoutMs: number;
  sizeBytes: number;
  /** Variables whose sealed value no longer opens — named so the person can re-enter them. */
  unreadableEnv: string[];
}

/** Run one shell command in the workspace; a long command needs its own timeout, up to the worker's ceiling. */
export async function sbWorkspaceExec(
  target: SandboxTarget,
  input: { id: string; command: string; timeoutMs?: number }
): Promise<ClientResult<WireExecResult>> {
  const cfg = sandboxConfig();
  if (!cfg) return { ok: false, err: { kind: 'unconfigured' } };
  // The client waits a little beyond the command's own limit: the worker
  // kills the process at timeoutMs and still has to answer.
  const wait = Math.min(15 * 60_000, (input.timeoutMs ?? 2 * 60_000) + 30_000);
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/workspaces/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...target, ...input }),
      signal: AbortSignal.timeout(wait),
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return opFailure(response);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return unreachable('The sandbox service answered an unreadable response.');
  }
  if (!isRecord(value) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string') {
    return malformed();
  }
  const num = (raw: unknown) => (typeof raw === 'number' ? raw : 0);
  return {
    ok: true,
    val: {
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
      signal: optStr(value.signal) ?? null,
      stdout: value.stdout,
      stderr: value.stderr,
      timedOut: value.timedOut === true,
      truncated: value.truncated === true,
      durationMs: num(value.durationMs),
      timeoutMs: num(value.timeoutMs),
      sizeBytes: num(value.sizeBytes),
      unreadableEnv: Array.isArray(value.unreadableEnv)
        ? value.unreadableEnv.filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
  };
}

export async function sbWorkspaceGitStatus(
  target: SandboxTarget,
  input: { id: string; diff?: boolean; log?: number }
): Promise<
  ClientResult<{ branch: string; status: string; diff?: string; diffStat?: string; log?: string }>
> {
  const result = await workspaceCall('git-status', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  return {
    ok: true,
    val: {
      branch: str(value.branch),
      status: str(value.status),
      ...(typeof value.diff === 'string' ? { diff: value.diff } : {}),
      ...(typeof value.diffStat === 'string' ? { diffStat: value.diffStat } : {}),
      ...(typeof value.log === 'string' ? { log: value.log } : {}),
    },
  };
}

export interface WireDiffFile {
  path: string;
  added: number;
  deleted: number;
  status: 'modified' | 'untracked';
}

/**
 * The working tree against HEAD: one unified diff (untracked files
 * included, each against nothing) and per-file line counts. `context`
 * is the lines around each hunk; `paths` narrows to some files.
 */
export async function sbWorkspaceGitDiff(
  target: SandboxTarget,
  input: { id: string; context?: number; paths?: string[]; statOnly?: boolean }
): Promise<
  ClientResult<{ branch: string; diff: string; files: WireDiffFile[]; truncated: boolean }>
> {
  const result = await workspaceCall('git-diff', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || !Array.isArray(value.files)) return malformed();
  const files: WireDiffFile[] = [];
  for (const raw of value.files) {
    if (!isRecord(raw)) return malformed();
    files.push({
      path: str(raw.path),
      added: typeof raw.added === 'number' ? raw.added : 0,
      deleted: typeof raw.deleted === 'number' ? raw.deleted : 0,
      status: raw.status === 'untracked' ? 'untracked' : 'modified',
    });
  }
  return {
    ok: true,
    val: {
      branch: str(value.branch),
      diff: str(value.diff),
      files,
      truncated: value.truncated === true,
    },
  };
}

/** One commit as the worker describes it (the `git-show` verb). */
export interface WireCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** The commit message past its subject line and the blank line after it, if any. */
  body: string;
  author: string;
  /** ISO 8601, as git wrote it. */
  date: string;
  parents: string[];
}

/**
 * One commit of the checkout by its hash (or a prefix): its header, its
 * diff against its parent with per-file counts, and where it stands —
 * `pushed` when a remote branch holds it, `inHead` when the current
 * branch's history does. `statOnly` skips the diff text.
 */
export async function sbWorkspaceGitShow(
  target: SandboxTarget,
  input: { id: string; commit: string; context?: number; statOnly?: boolean }
): Promise<
  ClientResult<{
    branch: string;
    commit: WireCommit;
    pushed: boolean;
    inHead: boolean;
    diff: string;
    files: WireDiffFile[];
    truncated: boolean;
  }>
> {
  const result = await workspaceCall('git-show', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || !isRecord(value.commit) || !Array.isArray(value.files)) {
    return malformed();
  }
  const files: WireDiffFile[] = [];
  for (const raw of value.files) {
    if (!isRecord(raw)) return malformed();
    files.push({
      path: str(raw.path),
      added: typeof raw.added === 'number' ? raw.added : 0,
      deleted: typeof raw.deleted === 'number' ? raw.deleted : 0,
      status: 'modified',
    });
  }
  const commit = value.commit;
  return {
    ok: true,
    val: {
      branch: str(value.branch),
      commit: {
        sha: str(commit.sha),
        shortSha: str(commit.shortSha),
        subject: str(commit.subject),
        body: str(commit.body),
        author: str(commit.author),
        date: str(commit.date),
        parents: Array.isArray(commit.parents)
          ? commit.parents.filter((entry): entry is string => typeof entry === 'string')
          : [],
      },
      pushed: value.pushed === true,
      inHead: value.inHead === true,
      diff: str(value.diff),
      files,
      truncated: value.truncated === true,
    },
  };
}

export async function sbWorkspaceGitCommit(
  target: SandboxTarget,
  input: {
    id: string;
    message: string;
    paths?: string[];
    newBranch?: string;
    author: { name: string; email: string };
  }
): Promise<ClientResult<{ branch: string; commit: string }>> {
  const result = await workspaceCall('git-commit', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  return { ok: true, val: { branch: str(value.branch), commit: str(value.commit) } };
}

export async function sbWorkspaceGitPush(
  target: SandboxTarget,
  input: { id: string; authHeader: string; branch?: string }
): Promise<ClientResult<{ branch: string; remoteBranch: string; output: string }>> {
  const result = await workspaceCall('git-push', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  return {
    ok: true,
    val: {
      branch: str(value.branch),
      remoteBranch: str(value.remoteBranch),
      output: str(value.output),
    },
  };
}

export async function sbWorkspaceGitPull(
  target: SandboxTarget,
  input: { id: string; authHeader: string; branch?: string }
): Promise<ClientResult<{ branch: string; output: string }>> {
  const result = await workspaceCall('git-pull', target, input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  return { ok: true, val: { branch: str(value.branch), output: str(value.output) } };
}

// ─── Workspace environment secrets ──────────────────────────────────────────

/** One variable as the worker describes it: the name and when — never the value. */
export interface WireEnvVariable {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

function envVariableOf(value: unknown): WireEnvVariable | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    createdAt: str(value.createdAt),
    updatedAt: str(value.updatedAt),
    lastUsedAt: optStr(value.lastUsedAt) ?? null,
  };
}

export async function sbEnvList(target: SandboxTarget): Promise<ClientResult<WireEnvVariable[]>> {
  const result = await callJson('env/list', { ...target });
  if (!result.ok) return result;
  if (!isRecord(result.val) || !Array.isArray(result.val.variables)) return malformed();
  const variables: WireEnvVariable[] = [];
  for (const raw of result.val.variables) {
    const variable = envVariableOf(raw);
    if (!variable) return malformed();
    variables.push(variable);
  }
  return { ok: true, val: variables };
}

/** Set (or replace) one variable. The value travels to the worker over the internal seam and nowhere else. */
export async function sbEnvSet(
  target: SandboxTarget,
  input: { name: string; value: string }
): Promise<ClientResult<WireEnvVariable>> {
  const result = await callJson('env/set', { ...target, ...input });
  if (!result.ok) return result;
  const variable = isRecord(result.val) ? envVariableOf(result.val.variable) : null;
  return variable ? { ok: true, val: variable } : malformed();
}

/**
 * Replace the whole set — a pasted .env file. Every name given is set,
 * every name absent is removed; the worker refuses the lot if any entry
 * is unacceptable. An empty map clears them.
 */
export async function sbEnvReplace(
  target: SandboxTarget,
  values: Record<string, string>
): Promise<ClientResult<WireEnvVariable[]>> {
  const result = await callJson('env/replace', { ...target, values });
  if (!result.ok) return result;
  if (!isRecord(result.val) || !Array.isArray(result.val.variables)) return malformed();
  const variables: WireEnvVariable[] = [];
  for (const raw of result.val.variables) {
    const variable = envVariableOf(raw);
    if (!variable) return malformed();
    variables.push(variable);
  }
  return { ok: true, val: variables };
}

export async function sbEnvDelete(
  target: SandboxTarget,
  name: string
): Promise<ClientResult<{ name: string }>> {
  const result = await callJson('env/delete', { ...target, name });
  if (!result.ok) return result;
  if (!isRecord(result.val) || !result.val.deleted) return malformed();
  return { ok: true, val: { name: str(result.val.name) } };
}

// ─── Code project services ──────────────────────────────────────────────────

export type WireServiceStatus = 'starting' | 'running' | 'stopped' | 'failed' | 'gone';

export interface WireService {
  id: string;
  name: string;
  image: string;
  status: WireServiceStatus;
  error: string | null;
  host: string | null;
  ports: number[];
  exportNames: string[];
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

function serviceStatusOf(value: unknown): WireServiceStatus {
  switch (value) {
    case 'starting':
    case 'running':
    case 'stopped':
    case 'gone':
      return value;
    default:
      return 'failed';
  }
}

function serviceOf(value: unknown): WireService | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  const status = str(value.status);
  if (!id || !name || !status) return null;
  return {
    id,
    name,
    image: str(value.image),
    status: serviceStatusOf(status),
    error: optStr(value.error) ?? null,
    host: optStr(value.host) ?? null,
    ports: Array.isArray(value.ports)
      ? value.ports.filter((port): port is number => typeof port === 'number')
      : [],
    exportNames: Array.isArray(value.exportNames)
      ? value.exportNames.filter((entry): entry is string => typeof entry === 'string')
      : [],
    createdAt: str(value.createdAt),
    lastUsedAt: str(value.lastUsedAt),
    expiresAt: str(value.expiresAt),
  };
}

function servicesOf(value: unknown): WireService[] | null {
  if (!isRecord(value) || !Array.isArray(value.services)) return null;
  const services: WireService[] = [];
  for (const raw of value.services) {
    const service = serviceOf(raw);
    if (!service) return null;
    services.push(service);
  }
  return services;
}

/** The project's services, each checked against the engine as it is listed. */
export async function sbServiceList(target: SandboxTarget): Promise<ClientResult<WireService[]>> {
  const result = await callJson('services/list', { ...target });
  if (!result.ok) return result;
  const services = servicesOf(result.val);
  return services ? { ok: true, val: services } : malformed();
}

/**
 * Start a service: pull the image (against the organization's rules),
 * run it beside the checkout, answer where it is. A pull can take
 * minutes, so this waits well past the ordinary request timeout.
 */
export async function sbServiceStart(
  target: SandboxTarget,
  input: {
    name: string;
    image: string;
    env?: Record<string, string>;
    exports?: Record<string, string>;
  }
): Promise<ClientResult<WireService>> {
  const cfg = sandboxConfig();
  if (!cfg) return { ok: false, err: { kind: 'unconfigured' } };
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/services/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...target, ...input }),
      signal: AbortSignal.timeout(6 * 60_000),
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return opFailure(response);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return unreachable('The sandbox service answered an unreadable response.');
  }
  const service = isRecord(value) ? serviceOf(value.service) : null;
  return service ? { ok: true, val: service } : malformed();
}

/** Stop a service: the container is stopped and removed with its data; the name is free again. */
export async function sbServiceStop(
  target: SandboxTarget,
  name: string
): Promise<ClientResult<WireService>> {
  const result = await callJson('services/stop', { ...target, name });
  if (!result.ok) return result;
  const service = isRecord(result.val) ? serviceOf(result.val.service) : null;
  return service ? { ok: true, val: service } : malformed();
}

export async function sbServiceLogs(
  target: SandboxTarget,
  input: { name: string; lines?: number }
): Promise<ClientResult<{ service: WireService; logs: string; truncated: boolean }>> {
  const result = await callJson('services/logs', { ...target, ...input });
  if (!result.ok) return result;
  if (!isRecord(result.val) || typeof result.val.logs !== 'string') return malformed();
  const service = serviceOf(result.val.service);
  if (!service) return malformed();
  return {
    ok: true,
    val: { service, logs: result.val.logs, truncated: result.val.truncated === true },
  };
}

// ─── The organization's image rules ─────────────────────────────────────────

export interface WireImageRule {
  id: string;
  pattern: string;
  note: string | null;
  registryUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

function imageRuleOf(value: unknown): WireImageRule | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const pattern = str(value.pattern);
  if (!id || !pattern) return null;
  return {
    id,
    pattern,
    note: optStr(value.note) ?? null,
    registryUsername: optStr(value.registryUsername) ?? null,
    createdAt: str(value.createdAt),
    updatedAt: str(value.updatedAt),
  };
}

function imageRulesOf(value: unknown): WireImageRule[] | null {
  if (!isRecord(value) || !Array.isArray(value.rules)) return null;
  const rules: WireImageRule[] = [];
  for (const raw of value.rules) {
    const rule = imageRuleOf(raw);
    if (!rule) return null;
    rules.push(rule);
  }
  return rules;
}

export async function sbImageRulesList(tenantId: string): Promise<ClientResult<WireImageRule[]>> {
  const result = await callJson('services/rules/list', { tenantId });
  if (!result.ok) return result;
  const rules = imageRulesOf(result.val);
  return rules ? { ok: true, val: rules } : malformed();
}

/**
 * Add a rule (no id) or change one (with its id). A registry credential
 * travels to the worker over the internal seam and nowhere else; on a
 * change, an absent credential leaves the stored one alone and
 * `clearCredential` removes it. `dropped` says what the worker took off
 * the pattern (a tag, a digest) to make a rule of it.
 */
export async function sbImageRuleSet(
  tenantId: string,
  input: {
    id?: string;
    pattern: string;
    note?: string | null;
    registryUsername?: string;
    registrySecret?: string;
    clearCredential?: boolean;
  }
): Promise<ClientResult<{ rule: WireImageRule; dropped: string | null }>> {
  const result = await callJson('services/rules/set', { tenantId, ...input });
  if (!result.ok) return result;
  const rule = isRecord(result.val) ? imageRuleOf(result.val.rule) : null;
  if (!rule) return malformed();
  return {
    ok: true,
    val: { rule, dropped: isRecord(result.val) ? (optStr(result.val.dropped) ?? null) : null },
  };
}

export async function sbImageRuleDelete(
  tenantId: string,
  id: string
): Promise<ClientResult<{ id: string }>> {
  const result = await callJson('services/rules/delete', { tenantId, id });
  if (!result.ok) return result;
  if (!isRecord(result.val) || !result.val.deleted) return malformed();
  return { ok: true, val: { id: str(result.val.id) } };
}

/** Put the seeded public images back, leaving what the organization added or kept. */
export async function sbImageRulesRestore(
  tenantId: string
): Promise<ClientResult<{ added: number; rules: WireImageRule[] }>> {
  const result = await callJson('services/rules/restore', { tenantId });
  if (!result.ok) return result;
  const rules = imageRulesOf(result.val);
  if (!rules || !isRecord(result.val)) return malformed();
  return {
    ok: true,
    val: { added: typeof result.val.added === 'number' ? result.val.added : 0, rules },
  };
}

/**
 * One shared mapping from a client error to a model-facing refusal, so
 * every sandbox_* tool and every batch-pipeline caller phrases the same
 * failure the same way.
 */
export function clientFailure(error: SandboxClientError): { status: number; message: string } {
  if (error.kind === 'unconfigured') {
    return {
      status: 503,
      message: 'The sandbox scratch space is not configured on this deployment.',
    };
  }
  if (error.kind === 'unreachable') {
    return { status: 502, message: 'Could not reach the sandbox service.' };
  }
  switch (error.type) {
    case 'not_found':
      return {
        status: 404,
        message: error.message ?? 'No such staged file (it may have expired).',
      };
    case 'workspaces_unavailable':
      return {
        status: 503,
        message: error.message ?? 'Code workspaces are not enabled on this deployment.',
      };
    case 'env_unavailable':
      return {
        status: 503,
        message: error.message ?? 'Environment secrets are not enabled on this deployment.',
      };
    case 'services_unavailable':
      return {
        status: 503,
        message: error.message ?? 'Code project services are not enabled on this deployment.',
      };
    case 'secrets_unavailable':
      return {
        status: 503,
        message: error.message ?? 'The worker has no key to seal a registry credential.',
      };
    case 'not_allowed':
      return { status: 403, message: error.message ?? 'That image is not allowed.' };
    case 'exists':
      return { status: 409, message: error.message ?? 'That name is taken.' };
    case 'engine':
      return { status: 502, message: error.message ?? 'The container engine refused.' };
    case 'not_ready':
      return { status: 409, message: error.message ?? 'That workspace is not ready yet.' };
    case 'bad_path':
      return {
        status: 400,
        message: error.message ?? 'That path is not usable inside the workspace.',
      };
    case 'binary_file':
      return { status: 415, message: error.message ?? 'That file is binary.' };
    case 'edit_conflict':
      return { status: 409, message: error.message ?? 'The edit did not apply.' };
    case 'git_failed':
      return { status: 409, message: error.message ?? 'git refused.' };
    case 'workspace_limit':
      return { status: 429, message: error.message ?? 'Too many workspaces — delete one first.' };
    case 'env_limit':
      return { status: 429, message: error.message ?? 'Too many variables — remove one first.' };
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
      return {
        status: 400,
        message: error.message ?? 'That ref is not on the current page — take a new snapshot.',
      };
    case 'navigation_failed':
      return { status: 502, message: error.message ?? 'The browser could not load that page.' };
    case 'action_failed':
      return {
        status: 400,
        message: error.message ?? 'The browser could not perform that action.',
      };
    case 'secret_unavailable':
      return { status: 403, message: error.message ?? 'That secret cannot be used here.' };
    case 'bad_passphrase':
      return {
        status: 403,
        message: error.message ?? 'That passphrase does not open this secret.',
      };
    case 'secret_exists':
      return { status: 409, message: error.message ?? 'A secret with that name already exists.' };
    case 'secret_limit':
      return { status: 429, message: error.message ?? 'Too many secrets — revoke one first.' };
    default:
      return { status: error.status, message: error.message ?? error.type };
  }
}
