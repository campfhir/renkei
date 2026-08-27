/**
 * The web app's client for the fileshare worker (apps/worker-fileshares) —
 * the ONLY way any web surface touches share bytes. SMB/SFTP sessions are
 * heavy I/O against servers with no self-defense, so they live in that
 * dedicated process; the web app holds no protocol library and decrypts no
 * credential — the worker resolves the CALLER'S OWN stored credential per
 * call, which is why every function here carries the caller's `subject`:
 * the file server then authorizes each operation as that account.
 *
 * Configuration: FILESHARES_WORKER_URL + FILESHARES_WORKER_API_KEY. Both
 * absent-or-set-together; a missing pair means every operation answers
 * 'unconfigured' — file shares are down, never open.
 *
 * Errors keep the worker's tag + message so each surface phrases its own
 * refusals; `clientFailure` gives the REST routes one shared status+string
 * mapping so a person and a model hear the same answer.
 */

import type { EntryKind, ShareCredentials } from '@renkei/connector-fileshares';

export interface WireShareRef {
  id: string;
  name: string;
}

/** A directory entry as the worker serializes it (dates as ISO strings). */
export interface WireEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: string | null;
}

export interface WireListing {
  share: WireShareRef;
  path: string;
  entries: WireEntry[];
}

export interface WireStat {
  share: WireShareRef;
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: string | null;
}

export interface WireRemovePreview {
  share: WireShareRef;
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: string | null;
}

export interface WireRelocation {
  share: WireShareRef;
  path: string;
  unchanged: boolean;
}

export type FileshareClientError =
  /** FILESHARES_WORKER_URL / _API_KEY are not set. */
  | { kind: 'unconfigured' }
  /** The worker could not be reached or answered garbage. */
  | { kind: 'unreachable'; message: string }
  /** The worker refused or failed the operation; type is the service tag. */
  | { kind: 'op'; type: string; message: string | undefined; status: number };

export type ClientResult<T> = { ok: true; val: T } | { ok: false; err: FileshareClientError };

export interface FileshareTarget {
  tenantId: string;
  shareId: string;
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

function config(): { url: string; key: string } | null {
  const url = process.env.FILESHARES_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.FILESHARES_WORKER_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

function unreachable(message: string): { ok: false; err: FileshareClientError } {
  return { ok: false, err: { kind: 'unreachable', message } };
}

async function opFailure(response: Response): Promise<{ ok: false; err: FileshareClientError }> {
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
  const cfg = config();
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
    return unreachable('The file share service answered an unreadable response.');
  }
}

function kindOf(value: unknown): EntryKind | null {
  return value === 'file' || value === 'dir' ? value : null;
}

function sizeOf(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function shareRefOf(value: unknown): WireShareRef | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  return id && name ? { id, name } : null;
}

function wireEntryOf(value: unknown): WireEntry | null {
  if (!isRecord(value)) return null;
  const kind = kindOf(value.kind);
  if (!kind) return null;
  return {
    name: str(value.name),
    path: str(value.path),
    kind,
    size: sizeOf(value.size),
    modifiedAt: optStr(value.modifiedAt) ?? null,
  };
}

function malformed<T>(): ClientResult<T> {
  return {
    ok: false,
    err: { kind: 'unreachable', message: 'The file share service answered an unexpected shape.' },
  };
}

export async function fsListFolder(
  target: FileshareTarget,
  path: string
): Promise<ClientResult<WireListing>> {
  const result = await callJson('list', { ...target, path });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const share = shareRefOf(value.share);
  if (!share) return malformed();
  const entries: WireEntry[] = [];
  if (!Array.isArray(value.entries)) return malformed();
  for (const raw of value.entries) {
    const entry = wireEntryOf(raw);
    if (!entry) return malformed();
    entries.push(entry);
  }
  return { ok: true, val: { share, path: str(value.path), entries } };
}

export async function fsStatEntry(
  target: FileshareTarget,
  path: string
): Promise<ClientResult<WireStat>> {
  const result = await callJson('stat', { ...target, path });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const share = shareRefOf(value.share);
  const kind = kindOf(value.kind);
  if (!share || !kind) return malformed();
  return {
    ok: true,
    val: {
      share,
      path: str(value.path),
      kind,
      size: sizeOf(value.size),
      modifiedAt: optStr(value.modifiedAt) ?? null,
    },
  };
}

export async function fsReadFile(
  target: FileshareTarget,
  path: string,
  maxBytes?: number
): Promise<ClientResult<Uint8Array>> {
  const called = await callOp('read', { ...target, path, maxBytes });
  if (!called.ok) return called;
  try {
    return { ok: true, val: new Uint8Array(await called.val.arrayBuffer()) };
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
}

export async function fsWriteFile(
  target: FileshareTarget,
  path: string,
  bytes: Uint8Array
): Promise<ClientResult<{ path: string }>> {
  const cfg = config();
  if (!cfg) return { ok: false, err: { kind: 'unconfigured' } };
  const query = new URLSearchParams({ ...target, path });
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
    return { ok: true, val: { path: isRecord(parsed) ? str(parsed.path) : path } };
  } catch {
    return { ok: true, val: { path } };
  }
}

export async function fsMakeFolder(
  target: FileshareTarget,
  path: string
): Promise<ClientResult<{ share: WireShareRef; path: string }>> {
  const result = await callJson('mkdir', { ...target, path });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const share = shareRefOf(value.share);
  if (!share) return malformed();
  return { ok: true, val: { share, path: str(value.path) } };
}

export async function fsRemoveEntry(
  target: FileshareTarget,
  path: string
): Promise<ClientResult<{ share: WireShareRef; path: string }>> {
  const result = await callJson('remove', { ...target, path });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const share = shareRefOf(value.share);
  if (!share) return malformed();
  return { ok: true, val: { share, path: str(value.path) } };
}

export async function fsPreviewRemove(
  target: FileshareTarget,
  path: string
): Promise<ClientResult<WireRemovePreview>> {
  const result = await callJson('remove-preview', { ...target, path });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const share = shareRefOf(value.share);
  const kind = kindOf(value.kind);
  if (!share || !kind) return malformed();
  return {
    ok: true,
    val: {
      share,
      path: str(value.path),
      kind,
      size: sizeOf(value.size),
      modifiedAt: optStr(value.modifiedAt) ?? null,
    },
  };
}

function relocationOf(value: unknown): WireRelocation | null {
  if (!isRecord(value)) return null;
  const share = shareRefOf(value.share);
  if (!share) return null;
  return { share, path: str(value.path), unchanged: value.unchanged === true };
}

export async function fsMoveEntry(
  target: FileshareTarget,
  path: string,
  toFolder: string
): Promise<ClientResult<WireRelocation>> {
  const result = await callJson('move', { ...target, path, toFolder });
  if (!result.ok) return result;
  const relocation = relocationOf(result.val);
  return relocation ? { ok: true, val: relocation } : malformed();
}

export async function fsRenameEntry(
  target: FileshareTarget,
  path: string,
  newName: string
): Promise<ClientResult<WireRelocation>> {
  const result = await callJson('rename', { ...target, path, newName });
  if (!result.ok) return result;
  const relocation = relocationOf(result.val);
  return relocation ? { ok: true, val: relocation } : malformed();
}

export interface TestConnectionPayload {
  tenantId: string;
  /** The stored share the credential is tried against. */
  shareId: string;
  credentials: ShareCredentials;
}

export async function fsTestConnection(
  payload: TestConnectionPayload
): Promise<ClientResult<{ entries: number }>> {
  const result = await callJson('test-connection', payload);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.entries !== 'number') return malformed();
  return { ok: true, val: { entries: value.entries } };
}

/**
 * The REST routes' one mapping from a client error to an HTTP answer, so a
 * person in the files browser and a model over MCP hear the same refusal.
 * Resolution tags get their own phrasings; backend tags fall back to the
 * worker's message. 'access_denied' is the file server's own verdict on the
 * caller's account — Renkei adds no verdicts of its own.
 */
export function clientFailure(error: FileshareClientError): { status: number; message: string } {
  if (error.kind === 'unconfigured') {
    return { status: 503, message: 'The file share service is not configured' };
  }
  if (error.kind === 'unreachable') {
    return { status: 502, message: 'The file share service cannot be reached' };
  }
  switch (error.type) {
    case 'no_share':
      return { status: 404, message: 'Not found' };
    case 'not_connected':
      return {
        status: 403,
        message: 'You have not connected this share — add your credentials on the Connectors page',
      };
    case 'bad_credentials':
      return {
        status: 503,
        message: 'Your stored credentials for this share cannot be read — reconnect it',
      };
    case 'access_denied':
      return { status: 403, message: 'The file server refused this with your credentials' };
    case 'store':
      return { status: 500, message: 'Could not read share access' };
    default:
      return { status: error.status, message: error.message ?? error.type };
  }
}
