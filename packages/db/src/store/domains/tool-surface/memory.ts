import type { MemoryTables } from '../../memory/tables';
import type { ToolSurfaceStore } from './types';

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** to_char(t, 'YYYYMMDDHH24MISS.US') in UTC; JavaScript keeps milliseconds, so the last three digits are 0. */
function formatVersion(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `.${pad(date.getUTCMilliseconds(), 3)}000`
  );
}

export function memoryToolSurface(tables: MemoryTables): ToolSurfaceStore {
  return {
    async version(subject) {
      const stamps: Date[] = [
        ...tables.select('provider_grants', (r) => r.subject === subject).map((r) => r.updated_at),
        ...tables.select('settings').map((r) => r.updated_at),
        ...tables.select('connector_configs').map((r) => r.updated_at),
        ...tables.select('file_shares').map((r) => r.updated_at),
        ...tables
          .select('file_share_connections', (r) => r.subject === subject)
          .map((r) => r.updated_at),
        ...tables.select('identities', (r) => r.subject === subject).map((r) => r.updated_at),
        ...tables.select('mcp_servers').map((r) => r.updated_at),
        ...tables
          .select('mcp_user_tool_lists', (r) => r.subject === subject)
          .map((r) => r.fetched_at),
      ];
      let newest: Date | null = null;
      for (const stamp of stamps) {
        if (stamp && (newest === null || stamp.getTime() > newest.getTime())) newest = stamp;
      }
      return newest ? formatVersion(newest) : null;
    },
  };
}
