/**
 * MCP servers and each person's cached tool list, through the data store
 * (`getDataStore().mcpServers`): the store keeps and returns rows, this
 * file narrows them into the connector's vocabulary. Everything returns a
 * Result; a storage error is an error, never "no servers".
 *
 * An admin's registration holds no per-person secret. The OAuth client
 * secret, when the server issued one, is sealed with the deployment key
 * (the `encrypted_secrets` idiom) and only ever opened by the delegate,
 * which performs the token exchange and refresh.
 */

import { getDataStore, type McpServerRecord } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import {
  MCP_AUTH_MODES,
  MCP_TRANSPORTS,
  parseStoredTools,
  readStoredOAuth,
  type McpAuthMode,
  type McpListedTool,
  type McpOAuthMetadata,
  type McpTransport,
} from './pure';

export type StoreError = 'DB_ERROR' | 'SLUG_TAKEN' | 'NOT_FOUND';

export interface McpServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: McpTransport;
  authMode: McpAuthMode;
  /** The admin's additional context, searched and shown with the server's tools. */
  context: string;
  oauth: McpOAuthMetadata | null;
  clientId: string | null;
  hasClientSecret: boolean;
  scopes: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function fromRecord(row: McpServerRecord): McpServer {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    transport: MCP_TRANSPORTS.find((t) => t === row.transport) ?? 'streamable_http',
    authMode: MCP_AUTH_MODES.find((m) => m === row.authMode) ?? 'oauth',
    context: row.context,
    oauth: readStoredOAuth(row.oauth),
    clientId: row.clientId,
    hasClientSecret: Boolean(row.encryptedClientSecret),
    scopes: row.scopes,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listServers(): Promise<Result<McpServer[], StoreError>> {
  const rows = await wrapAsync(() => getDataStore().mcpServers.list(), 'DB_ERROR' as const);
  return rows.ok ? ok(rows.val.map(fromRecord)) : rows;
}

export async function getServer(id: string): Promise<Result<McpServer | null, StoreError>> {
  const row = await wrapAsync(() => getDataStore().mcpServers.get(id), 'DB_ERROR' as const);
  return row.ok ? ok(row.val ? fromRecord(row.val) : null) : row;
}

export async function getServerBySlug(slug: string): Promise<Result<McpServer | null, StoreError>> {
  const row = await wrapAsync(() => getDataStore().mcpServers.getBySlug(slug), 'DB_ERROR' as const);
  return row.ok ? ok(row.val ? fromRecord(row.val) : null) : row;
}

/** The sealed client secret, for the delegate alone. */
export async function getSealedClientSecret(
  id: string
): Promise<Result<string | null, StoreError>> {
  const row = await wrapAsync(() => getDataStore().mcpServers.get(id), 'DB_ERROR' as const);
  return row.ok ? ok(row.val?.encryptedClientSecret ?? null) : row;
}

export interface NewServer {
  slug: string;
  name: string;
  url: string;
  transport: McpTransport;
  authMode: McpAuthMode;
  context: string;
  scopes: string | null;
  clientId: string | null;
  /** Already sealed; null leaves a public client. */
  encryptedClientSecret: string | null;
  enabled: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function createServer(input: NewServer): Promise<Result<McpServer, StoreError>> {
  try {
    return ok(fromRecord(await getDataStore().mcpServers.create(input)));
  } catch (error) {
    return err(isUniqueViolation(error) ? ('SLUG_TAKEN' as const) : ('DB_ERROR' as const));
  }
}

export interface ServerPatch {
  name?: string;
  url?: string;
  transport?: McpTransport;
  authMode?: McpAuthMode;
  context?: string;
  scopes?: string | null;
  enabled?: boolean;
  clientId?: string | null;
  /** `undefined` keeps the stored secret; `null` clears it. */
  encryptedClientSecret?: string | null;
  /** Discovery's answer; `null` clears it (the URL changed). */
  oauth?: McpOAuthMetadata | null;
}

export async function updateServer(
  id: string,
  patch: ServerPatch
): Promise<Result<McpServer, StoreError>> {
  const row = await wrapAsync(
    () => getDataStore().mcpServers.update(id, patch),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  return row.val ? ok(fromRecord(row.val)) : err('NOT_FOUND' as const);
}

export async function deleteServer(id: string): Promise<Result<void, StoreError>> {
  const deleted = await wrapAsync(() => getDataStore().mcpServers.delete(id), 'DB_ERROR' as const);
  return deleted.ok ? ok(undefined) : deleted;
}

// ── each person's cached tool list ─────────────────────────────────────────

export interface CachedToolList {
  serverId: string;
  tools: McpListedTool[];
  fetchedAt: Date;
}

export async function saveToolList(
  serverId: string,
  subject: string,
  tools: McpListedTool[]
): Promise<Result<void, StoreError>> {
  const saved = await wrapAsync(
    () => getDataStore().mcpServers.saveToolList(serverId, subject, tools),
    'DB_ERROR' as const
  );
  return saved.ok ? ok(undefined) : saved;
}

/** The person's cached lists for every server, keyed by server id. */
export async function getToolLists(
  subject: string
): Promise<Result<Map<string, CachedToolList>, StoreError>> {
  const rows = await wrapAsync(
    () => getDataStore().mcpServers.listToolLists(subject),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;
  return ok(
    new Map(
      rows.val.map((row) => [
        row.serverId,
        { serverId: row.serverId, tools: parseStoredTools(row.tools), fetchedAt: row.fetchedAt },
      ])
    )
  );
}

export async function clearToolList(
  serverId: string,
  subject: string
): Promise<Result<void, StoreError>> {
  const deleted = await wrapAsync(
    () => getDataStore().mcpServers.clearToolList(serverId, subject),
    'DB_ERROR' as const
  );
  return deleted.ok ? ok(undefined) : deleted;
}

/** Server ids this person holds a grant on — "connected". */
export async function connectedServerIds(subject: string): Promise<Result<string[], StoreError>> {
  const rows = await wrapAsync(
    () => getDataStore().providerGrants.listForSubject(subject, { providerPrefix: 'mcp:' }),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;
  return ok(rows.val.map((r) => r.provider.slice('mcp:'.length)));
}
