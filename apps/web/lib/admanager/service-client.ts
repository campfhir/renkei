/**
 * The web app's client for the ADManager Plus worker
 * (apps/worker-admanager) — the ONLY way any web surface reaches an
 * organization's ManageEngine ADManager Plus servers. Those usually live
 * in private address space the web app's SSRF guard refuses by design,
 * so the web app never dials them: the worker does, against URLs it
 * resolves from the tenant's stored instance registry, on the CALLER'S
 * OWN stored authtoken. This client only ever names a tenant, an
 * instance, a subject, and an API path.
 *
 * Configuration: ADMANAGER_WORKER_URL + ADMANAGER_WORKER_API_KEY. Both
 * absent-or-set-together; a missing pair means every operation answers
 * 'unconfigured' — ADManager Plus is down, never open.
 *
 * Errors keep the worker's tag + message so each surface phrases its own
 * refusals; `admanagerClientFailure` gives the REST routes one shared
 * status+string mapping so a person and a model hear the same answer.
 */

import type { HttpMethod, AdManagerCredentials } from '@renkei/connector-admanager';

export type AdManagerClientError =
  /** ADMANAGER_WORKER_URL / _API_KEY are not set. */
  | { kind: 'unconfigured' }
  /** The worker could not be reached or answered garbage. */
  | { kind: 'unreachable'; message: string }
  /** The worker refused or failed the operation; type is the worker's tag. */
  | { kind: 'op'; type: string; message: string | undefined; status: number };

export type AdManagerClientResult<T> =
  | { ok: true; val: T }
  | { ok: false; err: AdManagerClientError };

/** One ADManager Plus REST response, enveloped so the upstream status survives. */
export interface WireApiResponse {
  status: number;
  contentType: string | null;
  /** The raw response text; JSON when the API answered JSON. */
  body: string;
}

export interface AdManagerTarget {
  tenantId: string;
  instanceId: string;
  subject: string;
}

export interface AdManagerApiRequest {
  method: HttpMethod;
  /** An absolute API route, e.g. '/api/v2/users'. */
  path: string;
  /** Query parameters, encoded once by the worker; arrays repeat the key. */
  query?: Record<string, string | number | boolean | string[]>;
  /** A JSON value (serialized) or a raw string body. */
  body?: unknown;
  /** The Accept header (default application/json). */
  accept?: string;
}

const REQUEST_TIMEOUT_MS = 45_000;

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
  const url = process.env.ADMANAGER_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.ADMANAGER_WORKER_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** Whether the web app can reach an ADManager Plus worker at all. */
export function admanagerWorkerConfigured(): boolean {
  return config() !== null;
}

function unreachable(message: string): { ok: false; err: AdManagerClientError } {
  return { ok: false, err: { kind: 'unreachable', message } };
}

function malformed(): { ok: false; err: AdManagerClientError } {
  return unreachable('The ADManager Plus worker answered with an unexpected shape.');
}

async function opFailure(response: Response): Promise<{ ok: false; err: AdManagerClientError }> {
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

async function callOp(op: string, body: unknown): Promise<AdManagerClientResult<unknown>> {
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
  try {
    return { ok: true, val: await response.json() };
  } catch {
    return unreachable('The ADManager Plus worker answered an unreadable response.');
  }
}

/** One REST request on the caller's own stored authtoken. */
export async function admanagerApi(
  target: AdManagerTarget,
  request: AdManagerApiRequest
): Promise<AdManagerClientResult<WireApiResponse>> {
  const result = await callOp('api', { ...target, ...request });
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

export interface TestConnectionPayload {
  tenantId: string;
  /** The stored instance the credential is tried against. */
  instanceId: string;
  credentials: AdManagerCredentials;
}

/** The connect flow's validation: probe with an unsaved authtoken. */
export async function admanagerTestConnection(
  payload: TestConnectionPayload
): Promise<AdManagerClientResult<{ ok: true }>> {
  const result = await callOp('test-connection', payload);
  if (!result.ok) return result;
  return { ok: true, val: { ok: true } };
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** The admin form's reachability test, against a stored or unsaved instance. */
export async function admanagerProbe(
  tenantId: string,
  target:
    | { instanceId: string }
    | {
        unsaved: {
          baseUrl: string;
          tlsVerify: boolean;
          caPem?: string | null;
          allowInsecureHttp: boolean;
        };
      }
): Promise<AdManagerClientResult<ProbeResult>> {
  const result = await callOp('probe', { tenantId, ...target });
  if (!result.ok) return result;
  const value = result.val;
  if (!isRecord(value) || typeof value.ok !== 'boolean') return malformed();
  return {
    ok: true,
    val: {
      ok: value.ok,
      status: typeof value.status === 'number' ? value.status : undefined,
      error: optStr(value.error),
    },
  };
}

/**
 * One shared mapping from a client error to an HTTP answer, so a person on
 * the connectors page and a model over MCP hear the same refusal.
 */
export function admanagerClientFailure(error: AdManagerClientError): {
  status: number;
  message: string;
} {
  if (error.kind === 'unconfigured') {
    return { status: 503, message: 'The ADManager Plus service is not configured on this deployment' };
  }
  if (error.kind === 'unreachable') {
    return { status: 502, message: 'The ADManager Plus service cannot be reached' };
  }
  switch (error.type) {
    case 'no_instance':
      return { status: 404, message: 'Not found' };
    case 'not_connected':
      return {
        status: 403,
        message:
          'You have not connected this ADManager Plus instance — add your authtoken on the Connectors page',
      };
    case 'bad_credentials':
      return {
        status: 503,
        message: 'Your stored authtoken for this instance cannot be read or was rejected — reconnect it',
      };
    case 'store':
      return { status: 500, message: 'Could not read ADManager Plus connections' };
    case 'timeout':
      return { status: 504, message: 'The ADManager Plus server did not answer in time' };
    case 'unreachable':
      return { status: 502, message: error.message ?? 'The ADManager Plus server could not be reached' };
    default:
      return { status: error.status, message: error.message ?? error.type };
  }
}
