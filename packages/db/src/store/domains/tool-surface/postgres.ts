import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { ToolSurfaceStore } from './types';

export function postgresToolSurface(db: () => Kysely<DB>): ToolSurfaceStore {
  return {
    async version(subject) {
      const row = await sql<{ version: string | null }>`
        SELECT to_char(MAX(t), 'YYYYMMDDHH24MISS.US') AS version FROM (
          SELECT MAX(updated_at) AS t FROM provider_grants
            WHERE subject = ${subject}
          UNION ALL
          SELECT MAX(updated_at) FROM settings
          UNION ALL
          SELECT MAX(updated_at) FROM connector_configs
          UNION ALL
          SELECT MAX(updated_at) FROM file_shares
          UNION ALL
          SELECT MAX(updated_at) FROM file_share_connections
            WHERE subject = ${subject}
          UNION ALL
          SELECT MAX(updated_at) FROM identities
            WHERE subject = ${subject}
          UNION ALL
          SELECT MAX(updated_at) FROM mcp_servers
          UNION ALL
          SELECT MAX(fetched_at) FROM mcp_user_tool_lists
            WHERE subject = ${subject}
        ) AS sources
      `.execute(db());
      return row.rows[0]?.version ?? null;
    },
  };
}
