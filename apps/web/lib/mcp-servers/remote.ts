/**
 * Talking to a remote MCP server as a person: through the delegate, which
 * holds that person's grant on the server, attaches its token, refreshes it,
 * and refuses any origin but the server's own. This process never sees a
 * token (docs/delegate-key-design.md).
 *
 * A server's tools are listed once per person and cached
 * (`mcp_user_tool_lists`), because registering tools performs no I/O; the
 * cache is refreshed when the person connects, when they ask, and in the
 * background when it has gone stale.
 */

import { delegateRefusal, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import {
  McpAuthRequired,
  McpRemoteError,
  TOOL_LIST_TTL_MS,
  mcpProvider,
  saveToolList,
  withMcpSession,
  type McpCallResult,
  type McpFetch,
  type McpListedTool,
  type McpServer,
} from '@renkei/connector-mcp';
import { logger } from '@/lib/logger';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';

/** The delegate refusals that mean "this person has to connect (again)". */
const NEEDS_CONNECT = new Set(['NO_GRANT', 'GRANT_REVOKED', 'REFRESH_FAILED', 'GRANT_UNREADABLE']);

/** A fetch for one person on one server, with the delegate's refusals made legible. */
export function mcpFetchFor(
  server: Pick<McpServer, 'id'>,
  subject: string,
  options: { timeoutMs?: number } = {}
): McpFetch {
  const fetcher: AuthedFetch = grantFetch({ provider: mcpProvider(server.id), subject }, options);
  return async (url, init) => {
    const response = await fetcher(url, init);
    const refusal = delegateRefusal(response);
    if (refusal === null) return response;
    await response.body?.cancel().catch(() => undefined);
    if (NEEDS_CONNECT.has(refusal)) throw new McpAuthRequired(null);
    if (refusal === 'NEEDS_DELEGATION') {
      throw new McpRemoteError('Sign in to Renkei again, then retry; your connections are locked.');
    }
    throw new McpRemoteError(`The connection to the MCP server was refused (${refusal}).`);
  };
}

export type ListOutcome =
  | { ok: true; tools: McpListedTool[] }
  | { ok: false; reason: 'auth_required' | 'failed'; message: string };

/** The server's current tools for this person, straight from the server. */
export async function listRemoteTools(server: McpServer, subject: string): Promise<ListOutcome> {
  try {
    const tools = await withMcpSession(
      {
        url: server.url,
        transport: server.transport,
        fetch: mcpFetchFor(server, subject),
        timeoutMs: 20_000,
      },
      (session) => session.listTools()
    );
    return { ok: true, tools };
  } catch (error) {
    if (error instanceof McpAuthRequired) {
      return { ok: false, reason: 'auth_required', message: 'Connect this server again.' };
    }
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : 'Could not list the server’s tools.',
    };
  }
}

/** List and cache. A failed listing leaves the previous cache in place. */
export async function refreshToolList(server: McpServer, subject: string): Promise<ListOutcome> {
  const listed = await listRemoteTools(server, subject);
  if (!listed.ok) return listed;
  const saved = await saveToolList(server.id, subject, listed.tools);
  if (!saved.ok) {
    return { ok: false, reason: 'failed', message: 'Could not save the server’s tool list.' };
  }
  invalidateToolCatalogCache(subject);
  return listed;
}

const refreshing = new Set<string>();

/**
 * Refresh without making anyone wait: the next request sees the new list.
 * One refresh per (server, person) at a time, and a failure is only logged.
 */
export function refreshInBackground(server: McpServer, subject: string): void {
  const key = `${server.id}:${subject}`;
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void refreshToolList(server, subject)
    .then((outcome) => {
      if (!outcome.ok) {
        logger.warn('MCP tool list refresh failed: {reason}', {
          component: 'mcp-servers',
          server: server.slug,
          reason: outcome.reason,
        });
      }
    })
    .finally(() => refreshing.delete(key));
}

export function isStale(fetchedAt: Date, now = Date.now()): boolean {
  return now - fetchedAt.getTime() > TOOL_LIST_TTL_MS;
}

/** One call on the server, as the person. */
export async function callRemoteTool(
  server: Pick<McpServer, 'id' | 'url' | 'transport'>,
  subject: string,
  tool: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  return withMcpSession(
    {
      url: server.url,
      transport: server.transport,
      fetch: mcpFetchFor(server, subject),
      timeoutMs: 120_000,
    },
    (session) => session.callTool(tool, args)
  );
}
