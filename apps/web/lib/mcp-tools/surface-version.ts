/**
 * One scalar that changes whenever this caller's tool surface could have.
 *
 * ## Why not fingerprint the inputs
 *
 * The handler cache used to key on every value the registered tool set
 * depends on — fifteen positional arguments covering each connector's
 * availability, each grant's scopes, the org's read-only mode, its disabled
 * connectors, the redaction settings and the caller's email. That is correct
 * only for as long as somebody remembers to extend it. Adding a connector
 * and forgetting the key does not fail loudly: it serves a stale handler,
 * and because the cache had no expiry, it served one forever. `bitbucket`
 * had already drifted into being covered only incidentally, through the
 * scope fingerprint.
 *
 * A version derived from row timestamps cannot be forgotten, because it
 * names TABLES rather than fields. A new connector stores its grant in
 * `provider_grants` and its config in `connector_configs` like every other
 * one, so its arrival moves the version without anyone editing this file.
 *
 * ## Why not invalidate explicitly
 *
 * Because the cache is per-process. Clearing it on connect would clear it in
 * whichever replica served the connect, and leave every other replica
 * serving a stale handler indefinitely — the same trap `orgCache.delete`
 * already has, except that one self-heals after 60s and this would not. A
 * value read from the database is the same on every replica by
 * construction.
 *
 * ## What feeds it
 *
 * Every table that can change which tools register, or what a registered
 * tool closed over:
 *
 *   - `provider_grants`  — which connectors this caller has, and their scopes
 *   - `settings`  — read-only mode, disabled connectors, redaction
 *   - `connector_configs`— embeddings (the knowledge tools) and per-connector setup
 *   - `file_shares`      — which shares exist for the tenant
 *   - `file_share_connections` — this caller's per-share credentials and opt-ins
 *   - `identities`       — the caller's email, captured by search_knowledge's closure
 *   - `mcp_servers`      — which remote MCP servers exist and how to reach them
 *   - `mcp_user_tool_lists` — this caller's cached tools for each of them
 *
 * Tenant-wide tables are read tenant-wide on purpose: a share added for
 * anyone, or a setting changed by an admin, should retire every cached
 * handler in the tenant. Handlers are cheap to rebuild and staleness is what
 * we are paying to avoid.
 */

import { getDataStore } from '@renkei/db';
import { logger } from '@/lib/logger';

/**
 * The newest relevant `updated_at`, as an opaque string
 * (`toolSurface.version` in the data store reads it, one round trip).
 *
 * Returns `'unknown'` if the read fails, which is deliberately a CONSTANT
 * rather than a timestamp: a transient database error should not mint a
 * fresh key on every request and fill the cache with single-use handlers.
 * It means "reuse whatever is cached", and the next successful request
 * corrects it. `'empty'` is the constant for nothing stamped yet.
 */
export async function toolSurfaceVersion(subject: string): Promise<string> {
  try {
    return (await getDataStore().toolSurface.version(subject)) ?? 'empty';
  } catch (error) {
    logger.error('tool surface version could not be read: {error}', {
      component: 'mcp/surface',
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}
