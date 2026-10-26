/**
 * Kysely accessors for MCP servers and each person's cached tool list — the
 * only file that knows the table shapes. Everything returns a Result; a DB
 * error is an error, never "no servers".
 *
 * An admin's registration holds no per-person secret. The OAuth client
 * secret, when the server issued one, is sealed with the deployment key
 * (the `encrypted_secrets` idiom) and only ever opened by the delegate,
 * which performs the token exchange and refresh.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
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
import { log } from '@renkei/logging';

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

interface Row {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: string;
  auth_mode: string;
  context: string;
  oauth: unknown;
  client_id: string | null;
  encrypted_client_secret: string | null;
  scopes: string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = [
  'id',
  'slug',
  'name',
  'url',
  'transport',
  'auth_mode',
  'context',
  'oauth',
  'client_id',
  'encrypted_client_secret',
  'scopes',
  'enabled',
  'created_at',
  'updated_at',
] as const;

function fromRow(row: Row): McpServer {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    transport: MCP_TRANSPORTS.find((t) => t === row.transport) ?? 'streamable_http',
    authMode: MCP_AUTH_MODES.find((m) => m === row.auth_mode) ?? 'oauth',
    context: row.context,
    oauth: readStoredOAuth(row.oauth),
    clientId: row.client_id,
    hasClientSecret: Boolean(row.encrypted_client_secret),
    scopes: row.scopes,
    enabled: row.enabled,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export async function listServers(db: Kysely<DB>): Promise<Result<McpServer[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('mcp_servers')
        .select([...COLUMNS])
        .orderBy('name')
        .execute(),
    'DB_ERROR' as const
  );
  return rows.ok ? ok(rows.val.map(fromRow)) : rows;
}

export async function getServer(
  db: Kysely<DB>,
  id: string
): Promise<Result<McpServer | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('mcp_servers')
        .select([...COLUMNS])
        .where('id', '=', id)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  return row.ok ? ok(row.val ? fromRow(row.val) : null) : row;
}

export async function getServerBySlug(
  db: Kysely<DB>,
  slug: string
): Promise<Result<McpServer | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('mcp_servers')
        .select([...COLUMNS])
        .where('slug', '=', slug)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  return row.ok ? ok(row.val ? fromRow(row.val) : null) : row;
}

/** The sealed client secret, for the delegate alone. */
export async function getSealedClientSecret(
  db: Kysely<DB>,
  id: string
): Promise<Result<string | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('mcp_servers')
        .select('encrypted_client_secret')
        .where('id', '=', id)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  return row.ok ? ok(row.val?.encrypted_client_secret ?? null) : row;
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

export async function createServer(
  db: Kysely<DB>,
  input: NewServer
): Promise<Result<McpServer, StoreError>> {
  try {
    const row = await db
      .insertInto('mcp_servers')
      .values({
        slug: input.slug,
        name: input.name,
        url: input.url,
        transport: input.transport,
        auth_mode: input.authMode,
        context: input.context,
        scopes: input.scopes,
        client_id: input.clientId,
        encrypted_client_secret: input.encryptedClientSecret,
        enabled: input.enabled,
      })
      .returning([...COLUMNS])
      .executeTakeFirstOrThrow();
    return ok(fromRow(row));
  } catch (error) {
    const slugTaken = isUniqueViolation(error);
    if (!slugTaken) {
      log.warn('Could not save MCP server {slug}: {message}', {
        component: 'connector-mcp/store',
        slug: input.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return err(slugTaken ? ('SLUG_TAKEN' as const) : ('DB_ERROR' as const));
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
  db: Kysely<DB>,
  id: string,
  patch: ServerPatch
): Promise<Result<McpServer, StoreError>> {
  const values: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.url !== undefined) values.url = patch.url;
  if (patch.transport !== undefined) values.transport = patch.transport;
  if (patch.authMode !== undefined) values.auth_mode = patch.authMode;
  if (patch.context !== undefined) values.context = patch.context;
  if (patch.scopes !== undefined) values.scopes = patch.scopes;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.clientId !== undefined) values.client_id = patch.clientId;
  if (patch.encryptedClientSecret !== undefined) {
    values.encrypted_client_secret = patch.encryptedClientSecret;
  }
  if (patch.oauth !== undefined) values.oauth = patch.oauth ? JSON.stringify(patch.oauth) : null;
  const row = await wrapAsync(
    () =>
      db
        .updateTable('mcp_servers')
        .set(values)
        .where('id', '=', id)
        .returning([...COLUMNS])
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  return row.val ? ok(fromRow(row.val)) : err('NOT_FOUND' as const);
}

export async function deleteServer(db: Kysely<DB>, id: string): Promise<Result<void, StoreError>> {
  const deleted = await wrapAsync(
    () => db.deleteFrom('mcp_servers').where('id', '=', id).execute(),
    'DB_ERROR' as const
  );
  return deleted.ok ? ok(undefined) : deleted;
}

// ── each person's cached tool list ─────────────────────────────────────────

export interface CachedToolList {
  serverId: string;
  tools: McpListedTool[];
  fetchedAt: Date;
}

export async function saveToolList(
  db: Kysely<DB>,
  serverId: string,
  subject: string,
  tools: McpListedTool[]
): Promise<Result<void, StoreError>> {
  const json = JSON.stringify(tools);
  const saved = await wrapAsync(
    () =>
      db
        .insertInto('mcp_user_tool_lists')
        .values({ server_id: serverId, subject, tools: json, fetched_at: new Date() })
        .onConflict((oc) =>
          oc.columns(['server_id', 'subject']).doUpdateSet({ tools: json, fetched_at: new Date() })
        )
        .execute(),
    'DB_ERROR' as const
  );
  return saved.ok ? ok(undefined) : saved;
}

/** The person's cached lists for every server, keyed by server id. */
export async function getToolLists(
  db: Kysely<DB>,
  subject: string
): Promise<Result<Map<string, CachedToolList>, StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('mcp_user_tool_lists')
        .select(['server_id', 'tools', 'fetched_at'])
        .where('subject', '=', subject)
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;
  return ok(
    new Map(
      rows.val.map((row) => [
        row.server_id,
        {
          serverId: row.server_id,
          tools: parseStoredTools(row.tools),
          fetchedAt: new Date(row.fetched_at),
        },
      ])
    )
  );
}

export async function clearToolList(
  db: Kysely<DB>,
  serverId: string,
  subject: string
): Promise<Result<void, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('mcp_user_tool_lists')
        .where('server_id', '=', serverId)
        .where('subject', '=', subject)
        .execute(),
    'DB_ERROR' as const
  );
  return deleted.ok ? ok(undefined) : deleted;
}

/** Server ids this person holds a grant on — "connected". */
export async function connectedServerIds(
  db: Kysely<DB>,
  subject: string
): Promise<Result<string[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('provider_grants')
        .select('provider')
        .where('subject', '=', subject)
        .where('provider', 'like', 'mcp:%')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;
  return ok(rows.val.map((r) => r.provider.slice('mcp:'.length)));
}
