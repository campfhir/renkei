/**
 * The web app's client for the OnBase worker (apps/worker-onbase) — the
 * ONLY way any web surface reaches a customer's OnBase API Server or
 * Hyland IdP. Both usually live in private address space the web app's
 * SSRF guard refuses by design, so the web app never dials them: the
 * worker does, against URLs it resolves from the tenant's stored
 * configuration. This client only ever names a tenant, a person (their
 * OIDC subject), and an API path — never a token. The delegate opens the
 * person's OnBase grant and attaches the access token on the way to the
 * worker (docs/delegate-key-design.md), refreshing it when due; the code
 * exchange, refresh and revocation that used to live here are the
 * delegate's own `oauth/exchange`, `api` and `grant/revoke` now.
 *
 * Configuration: DELEGATE_WORKER_URL + DELEGATE_WORKER_API_KEY (the delegate
 * forwards to the worker; see `config()`). Both
 * absent-or-set-together; a missing pair means every operation answers
 * 'unconfigured' — OnBase is down, never open.
 *
 * Errors keep the worker's tag + message so each surface phrases its own
 * refusals; `onbaseClientFailure` gives the REST routes one shared
 * status+string mapping so a person and a model hear the same answer.
 *
 * One worker, two connectors: `onbase` (Document Management API) and
 * `onbase-admin` (Administration API) are separate Hyland OAuth clients
 * with separate `connector_configs` rows, exactly as Jira/JSM/Confluence/
 * Bitbucket are four separate Atlassian connectors. Every function here
 * takes an optional `connector`, forwarded verbatim to the worker, which
 * uses it to pick which row to resolve; omitted defaults to `onbase` there.
 */

import type { OnBaseIdpEndpoints } from '@renkei/connector-onbase';

export type OnBaseClientError =
  /** DELEGATE_WORKER_URL / _API_KEY are not set. */
  | { kind: 'unconfigured' }
  /** The worker could not be reached or answered garbage. */
  | { kind: 'unreachable'; message: string }
  /** The worker refused or failed the operation; type is the worker's tag. */
  | { kind: 'op'; type: string; message: string | undefined; status: number };

export type OnBaseClientResult<T> = { ok: true; val: T } | { ok: false; err: OnBaseClientError };

/** One Document API response, enveloped so the upstream status survives. */
export interface WireApiResponse {
  status: number;
  contentType: string | null;
  /** The raw response text; JSON when the API answered JSON. */
  body: string;
}

export interface WireContentResponse {
  bytes: Buffer;
  contentType: string;
  contentDisposition: string | null;
}

export interface WireTestConnection {
  idp: { ok: boolean; tokenEndpoint?: string; error?: string };
  api: { ok: boolean; status?: number; error?: string };
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

/**
 * The worker is reached THROUGH the delegate (docs/delegate-key-design.md,
 * decision 2): `forward/onbase/<op>` on DELEGATE_WORKER_URL. The delegate
 * opens the person's credential — this process holds no key — and
 * forwards the op to the worker with it attached; the answer comes back
 * as the worker gave it. ONBASE_WORKER_URL is the delegate's setting now.
 */
function config(): { url: string; key: string } | null {
  const url = process.env.DELEGATE_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.DELEGATE_WORKER_API_KEY?.trim();
  if (!url || !key) return null;
  return { url: `${url}/v1/forward/onbase`, key };
}

/** Whether the web app can reach an OnBase worker at all. */
export function onbaseWorkerConfigured(): boolean {
  return config() !== null;
}

function unreachable(message: string): { ok: false; err: OnBaseClientError } {
  return { ok: false, err: { kind: 'unreachable', message } };
}

function malformed(): { ok: false; err: OnBaseClientError } {
  return unreachable('The OnBase worker answered with an unexpected shape.');
}

async function opFailure(response: Response): Promise<{ ok: false; err: OnBaseClientError }> {
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
  // The delegate answers `unconfigured` when it has no address for this
  // worker: to a caller that is the same "service not configured" it used
  // to read off its own missing env, so it keeps that shape.
  if (type === 'unconfigured') return { ok: false, err: { kind: 'unconfigured' } };
  return { ok: false, err: { kind: 'op', type, message, status: response.status } };
}

async function callOp(
  op: string,
  body: unknown,
  init?: { headers?: Record<string, string>; rawBody?: Uint8Array<ArrayBuffer>; query?: string }
): Promise<OnBaseClientResult<Response>> {
  const cfg = config();
  if (!cfg) return { ok: false, err: { kind: 'unconfigured' } };
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/${op}${init?.query ?? ''}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.key}`,
        'content-type': init?.rawBody ? 'application/octet-stream' : 'application/json',
        ...(init?.headers ?? {}),
      },
      body: init?.rawBody ?? JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return opFailure(response);
  return { ok: true, val: response };
}

async function callJson(op: string, body: unknown): Promise<OnBaseClientResult<unknown>> {
  const called = await callOp(op, body);
  if (!called.ok) return called;
  try {
    return { ok: true, val: await called.val.json() };
  } catch {
    return malformed();
  }
}

export async function obDiscover(input: {
  tenantId: string;
  /** 'onbase' (default) or 'onbase-admin' — which connector's IdP issuer. */
  connector?: string;
  issuer?: string;
  allowInsecureHttp?: boolean;
}): Promise<OnBaseClientResult<OnBaseIdpEndpoints>> {
  const result = await callJson('discover', input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value)) return malformed();
  const issuer = str(value.issuer);
  const authorizationEndpoint = str(value.authorizationEndpoint);
  const tokenEndpoint = str(value.tokenEndpoint);
  if (!issuer || !authorizationEndpoint || !tokenEndpoint) return malformed();
  return {
    ok: true,
    val: {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      ...(optStr(value.revocationEndpoint)
        ? { revocationEndpoint: str(value.revocationEndpoint) }
        : {}),
    },
  };
}

export async function obApi(input: {
  tenantId: string;
  /** 'onbase' (default) or 'onbase-admin' — which connector's config/session. */
  connector?: string;
  /**
   * Who the call is for: the delegate opens THIS person's grant on the
   * named connector and attaches the access token. The worker also keys
   * the OnBase session cookie on it for the `onbase` connector, so one
   * person's session is never shared with another's.
   */
  subject: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  accept?: string;
}): Promise<OnBaseClientResult<WireApiResponse>> {
  const result = await callJson('api', input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.status !== 'number' || typeof value.body !== 'string') {
    return malformed();
  }
  return {
    ok: true,
    val: {
      status: value.status,
      contentType: optStr(value.contentType) ?? null,
      body: value.body,
    },
  };
}

export async function obContent(input: {
  tenantId: string;
  connector?: string;
  /** See obApi: whose grant, and the worker's session key. */
  subject: string;
  path: string;
  accept?: string;
}): Promise<OnBaseClientResult<WireContentResponse>> {
  const called = await callOp('content', input);
  if (!called.ok) return called;
  const bytes = Buffer.from(await called.val.arrayBuffer());
  return {
    ok: true,
    val: {
      bytes,
      contentType: called.val.headers.get('content-type') ?? 'application/octet-stream',
      contentDisposition: called.val.headers.get('content-disposition'),
    },
  };
}

export async function obPutBytes(input: {
  tenantId: string;
  /** 'onbase' (default) or 'onbase-admin' — whose grant the delegate opens. */
  connector?: string;
  /** See obApi: whose grant, and the worker's session key. */
  subject: string;
  uploadId: string;
  filePart: number;
  bytes: Uint8Array;
}): Promise<OnBaseClientResult<{ status: number }>> {
  const query = `?tenantId=${encodeURIComponent(input.tenantId)}&uploadId=${encodeURIComponent(
    input.uploadId
  )}&filePart=${input.filePart}`;
  const called = await callOp('put-bytes', undefined, {
    query,
    // A fresh ArrayBuffer-backed copy: fetch's BodyInit refuses the wider
    // Uint8Array<ArrayBufferLike> a caller may hold (e.g. a Buffer).
    rawBody: Uint8Array.from(input.bytes),
    // Headers, not query string: query strings end up in access logs. The
    // delegate reads these two to pick the grant, then forwards the bytes
    // with the token attached.
    headers: {
      'x-onbase-subject': input.subject,
      ...(input.connector ? { 'x-onbase-connector': input.connector } : {}),
    },
  });
  if (!called.ok) return called;
  let parsed: unknown;
  try {
    parsed = await called.val.json();
  } catch {
    return malformed();
  }
  if (!isRecord(parsed) || typeof parsed.status !== 'number') return malformed();
  return { ok: true, val: { status: parsed.status } };
}

export async function obTestConnection(input: {
  tenantId: string;
  connector?: string;
  unsaved?: { apiBaseUrl?: string; idpIssuer?: string; allowInsecureHttp?: boolean };
}): Promise<OnBaseClientResult<WireTestConnection>> {
  const result = await callJson('test-connection', input);
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || !isRecord(value.idp) || !isRecord(value.api)) return malformed();
  return {
    ok: true,
    val: {
      idp: {
        ok: value.idp.ok === true,
        tokenEndpoint: optStr(value.idp.tokenEndpoint),
        error: optStr(value.idp.error),
      },
      api: {
        ok: value.api.ok === true,
        status: typeof value.api.status === 'number' ? value.api.status : undefined,
        error: optStr(value.api.error),
      },
    },
  };
}

/**
 * One shared REST mapping for client failures, so every surface phrases
 * the same failure the same way.
 */
export function onbaseClientFailure(error: OnBaseClientError): { status: number; message: string } {
  switch (error.kind) {
    case 'unconfigured':
      return {
        status: 503,
        message:
          'The OnBase worker is not configured (DELEGATE_WORKER_URL / DELEGATE_WORKER_API_KEY).',
      };
    case 'unreachable':
      return { status: 502, message: `The OnBase worker could not be reached: ${error.message}` };
    case 'op':
      return {
        status: error.status,
        message: error.message ?? `The OnBase operation failed (${error.type}).`,
      };
  }
}
