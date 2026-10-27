import type { Selectable } from 'kysely';
import type { McpServers } from '../../../db.types';
import type { McpServerPatch, McpServerRecord, NewMcpServerRecord } from './types';

export function mcpServerFromRow(row: Selectable<McpServers>): McpServerRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    transport: row.transport,
    authMode: row.auth_mode,
    context: row.context,
    oauth: row.oauth ?? null,
    clientId: row.client_id,
    encryptedClientSecret: row.encrypted_client_secret,
    scopes: row.scopes,
    enabled: row.enabled,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function newServerValues(server: NewMcpServerRecord) {
  return {
    slug: server.slug,
    name: server.name,
    url: server.url,
    transport: server.transport,
    auth_mode: server.authMode,
    context: server.context,
    scopes: server.scopes,
    client_id: server.clientId,
    encrypted_client_secret: server.encryptedClientSecret,
    enabled: server.enabled,
  };
}

/** The columns a patch sets, `updated_at` always among them. */
export function patchValues(patch: McpServerPatch) {
  return {
    updated_at: new Date(),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.transport !== undefined ? { transport: patch.transport } : {}),
    ...(patch.authMode !== undefined ? { auth_mode: patch.authMode } : {}),
    ...(patch.context !== undefined ? { context: patch.context } : {}),
    ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.clientId !== undefined ? { client_id: patch.clientId } : {}),
    ...(patch.encryptedClientSecret !== undefined
      ? { encrypted_client_secret: patch.encryptedClientSecret }
      : {}),
    ...(patch.oauth !== undefined
      ? { oauth: patch.oauth === null ? null : JSON.stringify(patch.oauth) }
      : {}),
  };
}
