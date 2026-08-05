/**
 * Shared utilities for MCP tools.
 *
 * Adapted from renkei for Next.js context.
 */

import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db.types';
import type { Env } from '@/lib/env';
import { refreshAtlassianTokenDirect } from '@/lib/tenant-operations';

export interface MCPToolContext {
  tenantId: string;
  accountId: string;
  siteUrl: string;
  accessToken: string;
  maxJqlResults: number;
  db?: Kysely<DB>;
  config?: Env;
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
 * Cache for refresh-in-flight promises keyed by (tenantId:accountId).
 * Prevents thundering herd when multiple tools need token refresh simultaneously.
 */
const refreshInFlight = new Map<string, Promise<string>>();

function getRefreshKey(tenantId: string, accountId: string): string {
  return `${tenantId}:${accountId}`;
}

/**
 * Store token metadata for 24h TTL lookup during refresh.
 */
export function cacheTokenMetadata(accessToken: string, tenantId: string, accountId: string): void {
  tokenMetadataCache.set(accessToken, {
    tenantId,
    accountId,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
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
 * Make an authenticated request to Jira API with automatic token refresh on 401.
 * Looks up tenant/account from cached token metadata; requires prior cacheTokenMetadata() call.
 * Deduplicates concurrent refresh requests by (tenantId, accountId).
 * Returns response without throwing, allowing callers to handle non-ok statuses.
 */
export async function jiraFetch(
  url: string,
  accessToken: string,
  options?: RequestInit
): Promise<Response> {
  let token = accessToken;

  // Make initial request
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...options?.headers,
  };

  let response = await fetch(url, {
    ...options,
    headers,
  });

  // If 401, refresh token and retry
  if (response.status === 401) {
    const metadata = getTokenMetadata(accessToken);
    if (!metadata) {
      // Cannot refresh without tenant/account info; return 401
      return response;
    }

    const { tenantId, accountId } = metadata;
    const refreshKey = getRefreshKey(tenantId, accountId);

    // Check if refresh is already in-flight
    let refreshPromise = refreshInFlight.get(refreshKey);

    if (!refreshPromise) {
      // Start new refresh
      refreshPromise = refreshAtlassianTokenDirect(tenantId, accountId).then((result) => {
        // Clean up cache after refresh completes
        refreshInFlight.delete(refreshKey);

        if (!result.ok) {
          throw new Error(
            result.val === 'GRANT_REVOKED' ? 'GRANT_REVOKED' : 'Token refresh failed'
          );
        }

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
        return response; // Return original 401
      }
      throw error;
    }

    // Retry request with refreshed token
    const retryHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options?.headers,
    };

    response = await fetch(url, {
      ...options,
      headers: retryHeaders,
    });
  }

  return response;
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public isAuthError: boolean = status === 401
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}
