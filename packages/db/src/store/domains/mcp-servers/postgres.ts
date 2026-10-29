import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { mcpServerFromRow, newServerValues, patchValues } from './record';
import type { McpServerStore } from './types';

export function postgresMcpServers(db: () => Kysely<DB>): McpServerStore {
  return {
    async list() {
      const rows = await db()
        .selectFrom('mcp_servers')
        .selectAll()
        .orderBy('name')
        .orderBy('id')
        .execute();
      return rows.map(mcpServerFromRow);
    },
    async get(id) {
      const row = await db()
        .selectFrom('mcp_servers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? mcpServerFromRow(row) : null;
    },
    async getBySlug(slug) {
      const row = await db()
        .selectFrom('mcp_servers')
        .selectAll()
        .where('slug', '=', slug)
        .executeTakeFirst();
      return row ? mcpServerFromRow(row) : null;
    },
    async create(server) {
      const row = await db()
        .insertInto('mcp_servers')
        .values(newServerValues(server))
        .returningAll()
        .executeTakeFirstOrThrow();
      return mcpServerFromRow(row);
    },
    async update(id, patch) {
      const row = await db()
        .updateTable('mcp_servers')
        .set(patchValues(patch))
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row ? mcpServerFromRow(row) : null;
    },
    async delete(id) {
      const result = await db().deleteFrom('mcp_servers').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async saveToolList(serverId, subject, tools) {
      const json = JSON.stringify(tools);
      await db()
        .insertInto('mcp_user_tool_lists')
        .values({ server_id: serverId, subject, tools: json, fetched_at: new Date() })
        .onConflict((oc) =>
          oc.columns(['server_id', 'subject']).doUpdateSet({ tools: json, fetched_at: new Date() })
        )
        .execute();
    },
    async listToolLists(subject) {
      const rows = await db()
        .selectFrom('mcp_user_tool_lists')
        .select(['server_id', 'tools', 'fetched_at'])
        .where('subject', '=', subject)
        .orderBy('server_id')
        .execute();
      return rows.map((row) => ({
        serverId: row.server_id,
        tools: row.tools ?? null,
        fetchedAt: new Date(row.fetched_at),
      }));
    },
    async clearToolListsForServer(serverId) {
      const result = await db()
        .deleteFrom('mcp_user_tool_lists')
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async clearToolList(serverId, subject) {
      const result = await db()
        .deleteFrom('mcp_user_tool_lists')
        .where('server_id', '=', serverId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}
