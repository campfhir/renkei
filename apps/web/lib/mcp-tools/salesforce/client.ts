/**
 * Salesforce REST client, over the caller's own grant on the organization's
 * Salesforce app. Each call resolves its access fresh (the GitHub/Entra
 * shape); the token itself lives in the delegate, which attaches it,
 * refreshes it, retries a 401 once, and lets it travel to the org's own My
 * Domain alone (docs/delegate-key-design.md, apps/worker-delegate).
 *
 * Every path is built with `dataPath` — the pinned API version, v68.0 — and
 * goes to the instance the grant recorded, which the callback checked is
 * the configured org.
 *
 * Salesforce's error answer is an array of `{message, errorCode, fields}`;
 * it is returned to the model verbatim (the message, the code, and the
 * fields a validation rule is attached to), because the admin who wrote a
 * validation rule wrote that message for exactly this person.
 *
 * The org's API calls are a shared daily pool (every integration the
 * customer runs draws on it), so each answer's `Sforce-Limit-Info` header
 * is kept per org, and read TOOLS refuse once the org has used
 * API_BUDGET_FRACTION of its allowance. Writes still go through, including
 * the reads a write makes (the record before, the record after): the
 * budget is a property of the tool being run — read tools resolve their
 * access through `readAccess`, which refuses — not of the HTTP method.
 */

import { dataPath, type DataPolicy } from '@renkei/connector-salesforce';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import { chooseConnection, orgCall } from './org-choice';
import { salesforceScopeFor } from './scopes';
import { readSalesforceMetadata } from '@renkei/provider-grants';
import { SALESFORCE_CRM_KIND, type SalesforceKind } from '@/lib/salesforce-kinds';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { grantRefusalText, refusalTextOf } from '@/lib/grant-refusals';
import { logger, secure } from '@/lib/logger';
import { REQUEST_TIMEOUT_MS, isTimeoutError, timeoutSignal } from '../fetch-guard';

const LABEL = 'Salesforce';

/** Read tools stop once the org has used this much of its daily API allowance. */
export const API_BUDGET_FRACTION = 0.8;

export interface SalesforceAccess {
  /** `fetch` on the caller's own grant; the delegate supplies the credential. */
  auth: AuthedFetch;
  /** `<orgId>/<userId>`. */
  accountId: string;
  orgId: string;
  userId: string;
  /** The org's My Domain origin — the one host this grant's token goes to. */
  instanceUrl: string;
  username: string;
  /** The Salesforce connector (org) this call acts in. */
  connector: string;
  connectorName: string;
  sandbox: boolean;
  /** What this connector keeps away from the model (policy.ts). */
  policy: DataPolicy;
}

/** What the request wrapper needs of its caller — an MCPToolContext satisfies it. */
export interface SalesforceCallContext {
  subject?: string;
}

/**
 * The caller's connection to the org this call acts in (org-choice.ts):
 * the org asked for in `orgCall`, checked against the tool's capability.
 * The admin connector resolves the same way, on its own connectors, grants
 * and capability map.
 */
export async function resolveSalesforceAccess(
  context: SalesforceCallContext,
  kind: SalesforceKind = SALESFORCE_CRM_KIND,
  scopeFor: (tool: string) => string[] = salesforceScopeFor
): Promise<SalesforceAccess | string> {
  if (!context.subject) return 'No signed-in identity on this request.';
  const call = orgCall.getStore();
  const connectors = await listSalesforceConnectors(kind);
  const connections = await listSalesforceConnections(context.subject, connectors, kind.provider);
  const choice = chooseConnection(
    connectors,
    connections,
    call?.org,
    call ? scopeFor(call.tool) : [],
    kind.label,
    kind.key === SALESFORCE_CRM_KIND.key
  );
  if (!choice.ok) return choice.error;
  const grant = { provider: kind.provider, accountId: choice.connection.accountId };
  const described = await delegateGrants().describe(grant);
  if (!described.ok) {
    return described.err.type === 'NO_GRANT'
      ? `${kind.label} ${choice.org.name} is not connected. Connect it on the Connectors page, then try again.`
      : grantRefusalText(described.err.type, `${kind.label} ${choice.org.name}`);
  }
  const metadata = readSalesforceMetadata(described.val.metadata);
  return {
    auth: grantFetch(grant),
    accountId: described.val.accountId,
    orgId: metadata.orgId,
    userId: metadata.userId,
    // The connector's My Domain, which the callback checked the grant's org is.
    instanceUrl: choice.org.myDomain,
    username: metadata.username,
    connector: choice.org.key,
    connectorName: choice.org.name,
    sandbox: choice.org.sandbox,
    policy: choice.org.policy,
  };
}

export interface SalesforceError {
  message: string;
  errorCode: string;
  fields: string[];
}

export type SalesforceResult =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      /** The whole story for the model: Salesforce's own words where it gave them. */
      error: string;
      status?: number;
      errors: SalesforceError[];
    };

// ——— the org's API budget ———

const usageByOrg = new Map<string, { used: number; max: number; at: number }>();
const USAGE_TTL_MS = 15 * 60_000;

/** `api-usage=25/15000` from an answer's Sforce-Limit-Info header. */
export function parseLimitInfo(header: string | null): { used: number; max: number } | null {
  const match = header ? /api-usage=(\d+)\/(\d+)/.exec(header) : null;
  return match ? { used: Number(match[1]), max: Number(match[2]) } : null;
}

/** The org's last-seen API usage, when recent. */
export function apiUsage(orgId: string): { used: number; max: number } | null {
  const seen = usageByOrg.get(orgId);
  return seen && Date.now() - seen.at < USAGE_TTL_MS ? { used: seen.used, max: seen.max } : null;
}

/** Test hook: forget what the client has seen. */
export function resetApiUsage(): void {
  usageByOrg.clear();
}

/**
 * The access a READ tool runs on, or why not: the grant's own refusal, or
 * the org's API budget being mostly spent. Write tools resolve plainly.
 */
export async function readAccess(auth: {
  resolve(): Promise<SalesforceAccess | string>;
}): Promise<SalesforceAccess | string> {
  const access = await auth.resolve();
  if (typeof access === 'string') return access;
  return budgetRefusal(access.orgId) ?? access;
}

function budgetRefusal(orgId: string): string | null {
  const usage = apiUsage(orgId);
  if (!usage || usage.max === 0 || usage.used / usage.max < API_BUDGET_FRACTION) return null;
  return (
    `The org has used ${usage.used.toLocaleString('en-US')} of its ${usage.max.toLocaleString('en-US')} ` +
    `daily Salesforce API calls (every integration shares them), so reads are paused to leave ` +
    `room for the rest. Changes still go through. Try again later, or narrow what you need.`
  );
}

// ——— the request ———

function errorsOf(body: unknown): SalesforceError[] {
  const list = Array.isArray(body) ? body : [body];
  return list
    .map((entry) => rec(entry))
    .filter((entry) => typeof entry.message === 'string' || typeof entry.errorCode === 'string')
    .map((entry) => ({
      message: str(entry.message),
      errorCode: str(entry.errorCode),
      fields: strings(entry.fields),
    }));
}

/** Salesforce's own errors, one per line: `CODE: message (field: X, Y)`. */
export function describeErrors(errors: SalesforceError[]): string {
  return errors
    .map(
      (error) =>
        `${error.errorCode ? `${error.errorCode}: ` : ''}${error.message}` +
        (error.fields.length > 0 ? ` (field: ${error.fields.join(', ')})` : '')
    )
    .join('\n');
}

function describeStatus(status: number, errors: SalesforceError[]): string {
  const own = describeErrors(errors);
  if (status === 401) {
    return `Salesforce refused the connection (401); reconnect it on the Connectors page.${own ? `\n${own}` : ''}`;
  }
  if (status === 403) {
    return (
      own ||
      'Salesforce refused (403): your Salesforce user does not have access to this, or the ' +
        'connected app is not allowed for your user.'
    );
  }
  if (status === 404) return own || 'Not found (404), or not visible to your Salesforce user.';
  if (status === 412) {
    return (
      'The record changed in Salesforce since it was read (412) — someone else saved it. ' +
      'Read it again and redo the change on its current values.'
    );
  }
  return own || `Salesforce answered ${status}.`;
}

function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * One Salesforce call. `path` is either a data path under the pinned
 * version (`/sobjects/Account`, `/query?q=…`) or an absolute path the API
 * handed back (`/services/data/v68.0/query/01g…` from nextRecordsUrl).
 * Empty answers (204) come back as `null`.
 */
export async function sfRequest(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<SalesforceResult> {
  const resource = path.startsWith('/services/') ? path : dataPath(path);
  const url = `${access.instanceUrl}${resource}`;
  let response: Response;
  try {
    response = await access.auth(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Salesforce API unreachable', {
      component: 'salesforce/fetch',
      subject: context.subject,
      method,
      path,
      timedOut,
    });
    const host = new URL(access.instanceUrl).hostname;
    const reason = timedOut
      ? `${host} timed out after ${REQUEST_TIMEOUT_MS}ms`
      : `Could not reach ${host}`;
    return {
      ok: false,
      error:
        method === 'GET' || !timedOut
          ? reason
          : `${reason} — the change may still have gone through; check the record before retrying.`,
      errors: [],
    };
  }
  const refused = refusalTextOf(response, LABEL);
  if (refused) return { ok: false, error: refused, status: response.status, errors: [] };

  const usage = parseLimitInfo(response.headers.get('sforce-limit-info'));
  if (usage && access.orgId) usageByOrg.set(access.orgId, { ...usage, at: Date.now() });

  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — the status decides what the caller hears.
  }
  if (!response.ok) {
    const errors = errorsOf(parsed);
    logger.warn('Salesforce API non-OK response', {
      component: 'salesforce/fetch',
      subject: context.subject,
      method,
      path,
      status: response.status,
      responseBody: text ? secure(truncateForLog(text)) : undefined,
    });
    return {
      ok: false,
      error: describeStatus(response.status, errors),
      status: response.status,
      errors,
    };
  }
  return { ok: true, status: response.status, body: parsed };
}

/**
 * A binary resource (a file version's VersionData) as bytes, refused past
 * `maxBytes` — on the declared length first, so an oversized file is never
 * held in memory, then on the bytes, since Content-Length is optional.
 */
export async function sfDownload(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  path: string,
  maxBytes: number
): Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; error: string }> {
  const url = `${access.instanceUrl}${dataPath(path)}`;
  let response: Response;
  try {
    response = await access.auth(url, {
      method: 'GET',
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const host = new URL(access.instanceUrl).hostname;
    return {
      ok: false,
      error: isTimeoutError(error)
        ? `${host} timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `Could not reach ${host}`,
    };
  }
  const refused = refusalTextOf(response, LABEL);
  if (refused) return { ok: false, error: refused };
  const usage = parseLimitInfo(response.headers.get('sforce-limit-info'));
  if (usage && access.orgId) usageByOrg.set(access.orgId, { ...usage, at: Date.now() });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // The status decides.
    }
    logger.warn('Salesforce download non-OK response', {
      component: 'salesforce/fetch',
      subject: context.subject,
      path,
      status: response.status,
    });
    return { ok: false, error: describeStatus(response.status, errorsOf(parsed)) };
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      error: `${declared} bytes is over this org’s ${maxBytes}-byte file limit.`,
    };
  }
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      error: `${bytes.byteLength} bytes is over this org’s ${maxBytes}-byte file limit.`,
    };
  }
  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return { ok: true, bytes, contentType };
}

export const sfGet = (
  context: SalesforceCallContext,
  access: SalesforceAccess,
  path: string
): Promise<SalesforceResult> => sfRequest(context, access, 'GET', path);

/**
 * One SOQL page: the records with their `attributes` dropped, and the
 * cursor to the next. Not filtered by the connector's data policy — for
 * queries the tools build themselves from a describe (already filtered);
 * a model-written query goes through policy.ts's sfQueryPolicy.
 */
export async function sfQuery(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  soqlOrCursor: string
): Promise<
  | { ok: true; records: Record<string, unknown>[]; totalSize: number; next: string | null }
  | { ok: false; error: string }
> {
  const page = await sfQueryRaw(context, access, soqlOrCursor);
  return page.ok ? { ...page, records: page.records.map(stripAttributes) } : page;
}

/** sfQuery with each record's `attributes` (its type) kept. */
export async function sfQueryRaw(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  soqlOrCursor: string
): Promise<
  | { ok: true; records: Record<string, unknown>[]; totalSize: number; next: string | null }
  | { ok: false; error: string }
> {
  const path = soqlOrCursor.startsWith('/services/')
    ? soqlOrCursor
    : `/query?q=${encodeURIComponent(soqlOrCursor)}`;
  const result = await sfGet(context, access, path);
  if (!result.ok) return result;
  const body = rec(result.body);
  return {
    ok: true,
    records: recs(body.records),
    totalSize: typeof body.totalSize === 'number' ? body.totalSize : 0,
    next:
      body.done === false && typeof body.nextRecordsUrl === 'string' ? body.nextRecordsUrl : null,
  };
}

/** A record without Salesforce's `attributes` envelope, nested relationships included. */
export function stripAttributes(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = rec(value);
      out[key] = Array.isArray(nested.records)
        ? recs(nested.records).map(stripAttributes)
        : stripAttributes(nested);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A link that opens the record in Salesforce (the org redirects `/<id>` to its record page). */
export function recordUrl(access: SalesforceAccess, id: string): string {
  return `${access.instanceUrl}/${id}`;
}

// ——— shared shaping helpers ———

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

export function recs(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item)
      )
    : [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Compact JSON for the model: one level of indentation, no `attributes`. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 1);
}
