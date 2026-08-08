/**
 * Shared utilities for MCP tools.
 *
 * Adapted from renkei for Next.js context.
 */

import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { refreshAtlassianTokenDirect } from '@/lib/tenant-operations';
import { logger } from '@/lib/logger';

export interface MCPToolContext {
  tenantId: string;
  accountId: string;
  /**
   * Bare site domain (https://your-domain.atlassian.net). Browser links only —
   * `/browse/...`, boards, the JSM portal. OAuth 2.0 (3LO) bearer tokens are not
   * accepted here; use apiBaseUrl for anything under /rest.
   */
  siteUrl: string;
  /**
   * API gateway base (https://api.atlassian.com/ex/jira/{cloudId}). Every REST
   * call must go through this — 3LO tokens are rejected on the bare site domain.
   */
  apiBaseUrl: string;
  accessToken: string;
  maxJqlResults: number;
  /**
   * Public origin of this deployment (https://mcp.example.com), for links the
   * user must be able to open — the internal request URL behind a reverse
   * proxy is not reachable from outside.
   */
  origin?: string;
  /** Org limit for attachment uploads, from org settings. */
  maxAttachmentBytes?: number;
  /**
   * The caller's recorded email (identity spine), which the knowledge gate
   * verifies provider access against. Absent = gates fail closed.
   */
  userEmail?: string;
  /**
   * The caller's OIDC subject — the key for grants that are looked up per
   * call rather than resolved into the context (the WebEx user grant).
   */
  subject?: string;
  db?: Kysely<DB>;
}

/**
 * Jira project keys are uppercase alphanumeric; the numeric suffix is the
 * issue number. Validating here keeps a crafted key from being interpolated
 * into a path.
 */
export const issueKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'must look like PROJ-123 (uppercase project key, dash, number)');

/** Project keys without the issue number, for creation. */
export const projectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an uppercase project key, e.g. SCRUM');

export const attachmentFields = {
  filename: z
    .string()
    .min(1)
    .max(255)
    .describe('Name to store the file under. A path is reduced to its last segment.'),
  contentBase64: z
    .string()
    .min(1)
    .describe("The file's bytes, base64-encoded. A `data:` URL is also accepted."),
  contentType: z
    .string()
    .optional()
    .describe('MIME type. Inferred from the file extension when omitted.'),
};

export interface MCPToolResult {
  type: 'text' | 'image' | 'resource';
  text?: string;
  url?: string;
  data?: string;
  mimeType?: string;
}

export function ok(text: string): MCPToolResult {
  return { type: 'text', text };
}

export function okWithLink(text: string, url: string): MCPToolResult {
  return { type: 'text', text: `${text}\n\n[Open in Jira](${url})` };
}

export function toolError(text: string): MCPToolResult {
  return { type: 'text', text };
}

/** Generate a link to a Jira issue. */
export function issueUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl}/browse/${issueKey}`;
}

/** Generate a link to a Jira sprint board. */
export function sprintUrl(siteUrl: string, boardId: string | number): string {
  return `${siteUrl}/software/projects/SCRUM/boards/${boardId}`;
}

/** Generate a link to a Jira service desk request. */
export function requestUrl(siteUrl: string, requestKey: string): string {
  return `${siteUrl}/servicedesk/customer/portals/all/requests/${requestKey}`;
}

/**
 * Cache for token -> {tenantId, accountId} mapping.
 * Updated whenever a token is used successfully, expires after 24h.
 */
interface TokenMetadata {
  tenantId: string;
  accountId: string;
  expiresAt: number;
}
const tokenMetadataCache = new Map<string, TokenMetadata>();

/**
 * Cache for accountId -> displayName mapping.
 * Updated whenever user info is fetched, expires after 24h.
 */
interface UserMetadata {
  displayName: string;
  expiresAt: number;
}
const userMetadataCache = new Map<string, UserMetadata>();

/**
 * Cache for refresh-in-flight promises keyed by (tenantId:accountId).
 * Prevents thundering herd when multiple tools need token refresh simultaneously.
 */
const refreshInFlight = new Map<string, Promise<string>>();

/**
 * The freshest known access token per (tenantId:accountId).
 *
 * The MCP handler cache captures `context.accessToken` by value when the
 * handler is created, and that closure outlives the token. Without this map,
 * every call after the first expiry presented the stale token and paid a
 * 401 + refresh + retry round trip — forever. jiraFetch resolves the caller's
 * token through here first, and both a successful refresh and each incoming
 * request (via cacheTokenMetadata) keep it current.
 */
const currentTokens = new Map<string, string>();

function getRefreshKey(tenantId: string, accountId: string): string {
  return `${tenantId}:${accountId}`;
}

/**
 * Store token metadata for 24h TTL lookup during refresh, and record the
 * token as the freshest known one for its (tenantId, accountId).
 */
export function cacheTokenMetadata(accessToken: string, tenantId: string, accountId: string): void {
  tokenMetadataCache.set(accessToken, {
    tenantId,
    accountId,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
  currentTokens.set(getRefreshKey(tenantId, accountId), accessToken);
}

/**
 * Retrieve cached token metadata if still valid.
 */
function getTokenMetadata(accessToken: string): TokenMetadata | undefined {
  const cached = tokenMetadataCache.get(accessToken);
  if (!cached || cached.expiresAt < Date.now()) {
    tokenMetadataCache.delete(accessToken);
    return undefined;
  }
  return cached;
}

/**
 * Store user displayName for 24h TTL lookup.
 */
export function cacheUserDisplayName(accountId: string, displayName: string): void {
  userMetadataCache.set(accountId, {
    displayName,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

/**
 * Retrieve cached displayName if still valid.
 */
export function getCachedDisplayName(accountId: string): string | undefined {
  const cached = userMetadataCache.get(accountId);
  if (!cached || cached.expiresAt < Date.now()) {
    userMetadataCache.delete(accountId);
    return undefined;
  }
  return cached.displayName;
}

/**
 * Pull a human-readable reason out of an Atlassian error body. Jira returns
 * `{errorMessages: [...], errors: {...}}`, JSM returns `{errorMessage: "..."}`,
 * and a removed endpoint may return HTML or nothing at all.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Failure {
  reason: string;
  /**
   * Jira's per-field complaints, keyed by field id. Kept structured as well as
   * flattened into `reason`, because a caller that can retry without a refused
   * field needs to know which field that was, and the prose is not parseable.
   */
  fieldErrors: Record<string, string>;
}

async function describeFailure(response: Response): Promise<Failure> {
  const body = await response.text().catch(() => '');
  if (!body) return { reason: response.statusText || `HTTP ${response.status}`, fieldErrors: {} };

  try {
    const parsed: unknown = JSON.parse(body);
    if (isPlainObject(parsed)) {
      const fieldErrors: Record<string, string> = {};
      if (isPlainObject(parsed.errors)) {
        for (const [field, message] of Object.entries(parsed.errors)) {
          fieldErrors[field] = String(message);
        }
      }

      // errorMessages first, as before: it holds the whole-request complaint,
      // while `errors` details individual fields. Both are reported.
      const parts: string[] = [];
      if (Array.isArray(parsed.errorMessages) && parsed.errorMessages.length > 0) {
        parts.push(parsed.errorMessages.join('; '));
      }
      if (typeof parsed.errorMessage === 'string' && parsed.errorMessage) {
        parts.push(parsed.errorMessage);
      }
      const fieldPart = Object.entries(fieldErrors)
        .map(([field, message]) => `${field}: ${message}`)
        .join('; ');
      if (fieldPart) parts.push(fieldPart);

      if (parts.length > 0) return { reason: parts.join(' | '), fieldErrors };
    }
  } catch {
    // Not JSON — fall through to the truncated raw body.
  }

  return { reason: body.slice(0, 300), fieldErrors: {} };
}

/**
 * Make an authenticated request to Jira API with automatic token refresh on 401.
 * Looks up tenant/account from cached token metadata; requires prior cacheTokenMetadata() call.
 * Deduplicates concurrent refresh requests by (tenantId, accountId).
 *
 * Throws JiraApiError on any non-2xx. This previously returned the response
 * untouched "so callers can handle non-ok statuses" — but no caller ever did,
 * so a 404 or 410 was parsed as JSON, failed an `isArray(data.issues)` check,
 * and surfaced as "no results" or even a false success message. Failing loudly
 * here is what makes a wrong endpoint visible instead of silently empty.
 */
export async function jiraFetch(
  url: string,
  accessToken: string,
  options?: RequestInit
): Promise<Response> {
  const metadata = getTokenMetadata(accessToken);
  // The caller's token may be a stale capture from a cached handler closure;
  // when its owner is known, use the freshest token recorded for that owner.
  let token = metadata
    ? (currentTokens.get(getRefreshKey(metadata.tenantId, metadata.accountId)) ?? accessToken)
    : accessToken;
  const displayName = metadata?.accountId ? getCachedDisplayName(metadata.accountId) : undefined;
  // Deliberately no token material here, not even a prefix: these records are
  // persisted by the Postgres log adapter and are readable over HTTP.
  logger.debug('[jiraFetch] Request', {
    tenantId: metadata?.tenantId,
    accountId: metadata?.accountId,
    displayName,
    url,
    method: options?.method || 'GET',
  });

  // A FormData body must carry its own multipart boundary, so no Content-Type
  // may be preset for it — fetch generates the header from the body.
  const contentTypeHeader: Record<string, string> =
    options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };

  // Make initial request
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...contentTypeHeader,
    ...options?.headers,
  };

  let response = await fetch(url, {
    ...options,
    headers,
  });
  logger.debug('[jiraFetch] Response', {
    tenantId: metadata?.tenantId,
    accountId: metadata?.accountId,
    url,
    status: response.status,
  });

  // If 401, refresh token and retry
  if (response.status === 401) {
    if (!metadata) {
      logger.warn('[jiraFetch] 401 but no token metadata for refresh', { url });
      throw new JiraApiError(
        'Jira rejected the credential and no refresh metadata was available',
        401
      );
    }

    const { tenantId, accountId } = metadata;
    const refreshKey = getRefreshKey(tenantId, accountId);
    logger.info('[jiraFetch] 401 response, refreshing token', { tenantId, accountId, url });

    // Check if refresh is already in-flight
    let refreshPromise = refreshInFlight.get(refreshKey);

    if (!refreshPromise) {
      // Start new refresh
      refreshPromise = refreshAtlassianTokenDirect(tenantId, accountId).then((result) => {
        // Clean up cache after refresh completes
        refreshInFlight.delete(refreshKey);

        if (!result.ok) {
          // safe-functions puts the error code at .err.type, not .val
          const error =
            result.err.type === 'GRANT_REVOKED' ? 'GRANT_REVOKED' : 'Token refresh failed';
          logger.error('[jiraFetch] Token refresh failed', { tenantId, accountId, error });
          throw new Error(error);
        }

        logger.info('[jiraFetch] Token refresh success', { tenantId, accountId });
        // Record the new token so later calls holding the stale capture skip
        // the 401 round trip entirely.
        cacheTokenMetadata(result.val.accessToken, tenantId, accountId);
        return result.val.accessToken;
      });

      refreshInFlight.set(refreshKey, refreshPromise);
    }

    // Wait for refresh to complete (either this call or a concurrent one)
    try {
      token = await refreshPromise;
    } catch (error) {
      // If grant is revoked, return 401 response to signal need for reauth
      if (error instanceof Error && error.message === 'GRANT_REVOKED') {
        logger.warn('[jiraFetch] Grant revoked', { url });
        throw new JiraApiError('GRANT_REVOKED', 401, true);
      }
      throw error;
    }

    // Retry request with refreshed token
    logger.debug('[jiraFetch] Retrying with refreshed token', {
      tenantId: metadata.tenantId,
      accountId: metadata.accountId,
      url,
    });
    const retryHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...contentTypeHeader,
      ...options?.headers,
    };

    response = await fetch(url, {
      ...options,
      headers: retryHeaders,
    });
    logger.debug('[jiraFetch] Retry response', {
      tenantId: metadata.tenantId,
      accountId: metadata.accountId,
      url,
      status: response.status,
    });
  }

  if (!response.ok) {
    const failure = await describeFailure(response);
    logger.warn('[jiraFetch] Non-OK response', {
      tenantId: metadata?.tenantId,
      accountId: metadata?.accountId,
      url,
      method: options?.method || 'GET',
      status: response.status,
      reason: failure.reason,
    });
    throw new JiraApiError(
      `Jira API ${response.status}: ${failure.reason}`,
      response.status,
      response.status === 401,
      failure.fieldErrors
    );
  }

  return response;
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public isAuthError: boolean = status === 401,
    /** Jira's per-field complaints, so a caller can retry without them. */
    public fieldErrors: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}
