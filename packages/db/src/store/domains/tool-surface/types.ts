/**
 * The one scalar that moves whenever a person's MCP tool surface could
 * have (apps/web/lib/mcp-tools/surface-version.ts says why it is derived
 * rather than fingerprinted).
 */
export interface ToolSurfaceStore {
  /**
   * The newest change among the rows that shape a subject's tool surface —
   * their `provider_grants`, `file_share_connections`, `identities` row and
   * `mcp_user_tool_lists` (by `fetched_at`), and every `settings`,
   * `connector_configs`, `file_shares` and `mcp_servers` row — as
   * `YYYYMMDDHH24MISS.US`, or null when none of them has a timestamp.
   * Postgres formats in the session's time zone; memory in UTC (the
   * contract database's zone).
   */
  version(subject: string): Promise<string | null>;
}
