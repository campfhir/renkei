/**
 * The web app's client for the OnBase worker (apps/worker-onbase) — the
 * ONLY way any web surface reaches a customer's OnBase API Server or
 * Hyland IdP. Both usually live in private address space the web app's
 * SSRF guard refuses by design, so the web app never dials them: the
 * worker does, against URLs it resolves from the tenant's stored
 * configuration. This client only ever names a tenant, an access token,
 * and an API path.
 *
 * Configuration: ONBASE_WORKER_URL + ONBASE_WORKER_API_KEY. Both
 * absent-or-set-together; a missing pair means every operation answers
 * 'unconfigured' — OnBase is down, never open.
 *
 * Errors keep the worker's tag + message so each surface phrases its own
 * refusals; `onbaseClientFailure` gives the REST routes one shared
 * status+string mapping so a person and a model hear the same answer.
 */

import type { OnBaseIdpEndpoints } from '@renkei/connector-onbase';

export type OnBaseClientError =
  /** ONBASE_WORKER_URL / _API_KEY are not set. */
  | { kind: 'unconfigured' }
  /** The worker could not be reached or answered garbage. */
  | { kind: 'unreachable'; message: string }
  /** The worker refused or failed the operation; type is the worker's tag. */
  | { kind: 'op'; type: string; message: string | undefined; status: number };

export type OnBaseClientResult<T> = { ok: true; val: T } | { ok: false; err: OnBaseClientError };

/** The IdP token response, narrowed to the fields Renkei reads. */
export interface WireTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

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

function config(): { url: string; key: string } | null {
  const url = process.env.ONBASE_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.ONBASE_WORKER_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
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
    response = await fetch(`${cfg.url}/v1/${op}${init?.query ?? ''}`, {
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

function tokenResponseOf(value: unknown): OnBaseClientResult<WireTokenResponse> {
  if (!isRecord(value) || typeof value.access_token !== 'string') return malformed();
  return {
    ok: true,
    val: {
      access_token: value.access_token,
      ...(typeof value.refresh_token === 'string' ? { refresh_token: value.refresh_token } : {}),
      ...(typeof value.id_token === 'string' ? { id_token: value.id_token } : {}),
      ...(typeof value.expires_in === 'number' ? { expires_in: value.expires_in } : {}),
      ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    },
  };
}

export async function obExchangeCode(input: {
  tenantId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OnBaseClientResult<WireTokenResponse>> {
  const result = await callJson('token', {
    tenantId: input.tenantId,
    grant: {
      type: 'authorization_code',
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    },
  });
  if (!result.ok) return result;
  return tokenResponseOf(result.val);
}

export async function obRefreshToken(input: {
  tenantId: string;
  refreshToken: string;
}): Promise<OnBaseClientResult<WireTokenResponse>> {
  const result = await callJson('token', {
    tenantId: input.tenantId,
    grant: { type: 'refresh_token', refreshToken: input.refreshToken },
  });
  if (!result.ok) return result;
  return tokenResponseOf(result.val);
}

export async function obRevoke(input: {
  tenantId: string;
  token: string;
  tokenTypeHint?: string;
}): Promise<OnBaseClientResult<{ revoked: boolean }>> {
  const result = await callJson('revoke', input);
  if (!result.ok) return result;
  if (!isRecord(result.val) || typeof result.val.revoked !== 'boolean') return malformed();
  return { ok: true, val: { revoked: result.val.revoked } };
}

export async function obApi(input: {
  tenantId: string;
  accessToken: string;
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
  accessToken: string;
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
  uploadId: string;
  filePart: number;
  accessToken: string;
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
    headers: { 'x-onbase-token': input.accessToken },
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
          'The OnBase worker is not configured (ONBASE_WORKER_URL / ONBASE_WORKER_API_KEY).',
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
