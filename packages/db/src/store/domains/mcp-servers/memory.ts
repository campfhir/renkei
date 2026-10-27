import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { mcpServerFromRow, newServerValues, patchValues } from './record';
import type { McpServerStore } from './types';

export function memoryMcpServers(tables: MemoryTables): McpServerStore {
  const byId = (id: string) => {
    const wanted = tables.param('mcp_servers', 'id', id);
    return (r: { id: string }) => r.id === wanted;
  };
  return {
    async list() {
      return orderBy(tables.select('mcp_servers'), [(r) => r.name], [(r) => r.id]).map(
        mcpServerFromRow
      );
    },
    async get(id) {
      const row = tables.first('mcp_servers', byId(id));
      return row ? mcpServerFromRow(row) : null;
    },
    async getBySlug(slug) {
      const row = tables.first('mcp_servers', (r) => r.slug === slug);
      return row ? mcpServerFromRow(row) : null;
    },
    async create(server) {
      return mcpServerFromRow(tables.insert('mcp_servers', newServerValues(server)));
    },
    async update(id, patch) {
      const [row] = tables.update('mcp_servers', byId(id), patchValues(patch));
      return row ? mcpServerFromRow(row) : null;
    },
    async delete(id) {
      return tables.delete('mcp_servers', byId(id)).length;
    },
    async saveToolList(serverId, subject, tools) {
      const json = JSON.stringify(tools);
      const now = new Date();
      tables.upsert(
        'mcp_user_tool_lists',
        { server_id: serverId, subject, tools: json, fetched_at: now },
        ['server_id', 'subject'],
        { tools: json, fetched_at: now }
      );
    },
    async listToolLists(subject) {
      return orderBy(
        tables.select('mcp_user_tool_lists', (r) => r.subject === subject),
        [(r) => r.server_id]
      ).map((row) => ({
        serverId: row.server_id,
        tools: row.tools ?? null,
        fetchedAt: new Date(row.fetched_at),
      }));
    },
    async clearToolListsForServer(serverId) {
      const wanted = tables.param('mcp_user_tool_lists', 'server_id', serverId);
      return tables.delete('mcp_user_tool_lists', (r) => r.server_id === wanted).length;
    },
    async clearToolList(serverId, subject) {
      const wanted = tables.param('mcp_user_tool_lists', 'server_id', serverId);
      return tables.delete(
        'mcp_user_tool_lists',
        (r) => r.server_id === wanted && r.subject === subject
      ).length;
    },
  };
}
