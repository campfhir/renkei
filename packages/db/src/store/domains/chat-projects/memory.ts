import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import {
  newProjectValues,
  projectFromRow,
  projectMemoryFromRow,
  projectPatchValues,
} from './record';
import type { ChatProjectStore } from './types';

export function memoryChatProjects(tables: MemoryTables): ChatProjectStore {
  const memoryRows = (id: unknown) =>
    orderBy(
      tables.select('chat_project_memories', (r) => r.project_id === id),
      [(r) => r.created_at, 'desc'],
      [(r) => r.id]
    );

  return {
    async get(id) {
      const wanted = id;
      const row = tables.first('chat_projects', (r) => r.id === wanted);
      return row ? projectFromRow(row) : null;
    },
    async listOwned(ownerSubject) {
      return orderBy(
        tables.select('chat_projects', (r) => r.owner_subject === ownerSubject),
        [(r) => r.updated_at, 'desc'],
        [(r) => r.id]
      ).map(projectFromRow);
    },
    async listByIds(projectIds, options = {}) {
      if (projectIds.length === 0) return [];
      const ids = new Set(projectIds);
      const rows = tables.select('chat_projects', (r) => ids.has(r.id));
      const sorted =
        options.orderBy === 'name'
          ? orderBy(rows, [(r) => r.name], [(r) => r.id])
          : orderBy(rows, [(r) => r.updated_at, 'desc'], [(r) => r.id]);
      return sorted.map(projectFromRow);
    },
    async withGrantCounts(projectIds) {
      if (projectIds.length === 0) return [];
      const ids = new Set(projectIds);
      const now = Date.now();
      return orderBy(
        tables.select('chat_projects', (r) => ids.has(r.id)),
        [(r) => r.id]
      ).map((project) => ({
        id: project.id,
        name: project.name,
        kind: project.kind,
        grants: tables.select(
          'resource_access_grants',
          (g) =>
            g.resource_kind === 'chat_project' &&
            g.resource_id === project.id &&
            (g.expires_at === null || g.expires_at.getTime() > now)
        ).length,
      }));
    },
    async create(project) {
      const now = new Date();
      return tables.insert('chat_projects', {
        id: globalThis.crypto.randomUUID(),
        kind: 'chat',
        repo_provider: null,
        repo_full_name: null,
        repo_branch: null,
        workspace_id: null,
        published_to_org: false,
        created_at: now,
        updated_at: now,
        ...newProjectValues(project),
        tool_config: project.toolConfig == null ? null : toJson(project.toolConfig),
      }).id;
    },
    async update(id, patch) {
      const wanted = id;
      return (
        tables.update('chat_projects', (r) => r.id === wanted, {
          ...projectPatchValues(patch),
          ...(patch.toolConfig !== undefined
            ? { tool_config: patch.toolConfig == null ? null : toJson(patch.toolConfig) }
            : {}),
          updated_at: new Date(),
        }).length > 0
      );
    },
    async delete(ownerSubject, id) {
      const wanted = id;
      const deleted =
        tables.delete('chat_projects', (r) => r.owner_subject === ownerSubject && r.id === wanted)
          .length > 0;
      if (deleted) {
        // Its memory, references and PR watches go; its chats stay, unfiled.
        tables.delete('chat_project_memories', (r) => r.project_id === wanted);
        tables.delete('artifact_references', (r) => r.project_id === wanted);
        tables.delete('pr_subscriptions', (r) => r.project_id === wanted);
        tables.update('chats', (r) => r.project_id === wanted, { project_id: null });
      }
      return deleted;
    },
    async listMemory(id, limit) {
      return page(memoryRows(id), limit).map(projectMemoryFromRow);
    },
    async appendMemory(entry) {
      const inserted = tables.insert('chat_project_memories', {
        project_id: entry.projectId,
        kind: 'entry',
        content: entry.content,
        author_subject: entry.authorSubject,
        chat_id: entry.chatId,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      const beyond = new Set(
        memoryRows(inserted.project_id)
          .filter((r) => r.kind === 'entry')
          .slice(entry.keep)
          .map((r) => r.id)
      );
      tables.delete('chat_project_memories', (r) => beyond.has(r.id));
      return inserted.id;
    },
    async forgetMemory(id, target) {
      if (target.kind === 'entries' && target.ids.length === 0) return 0;
      const wanted = id;
      const ids = target.kind === 'entries' ? new Set(target.ids.map((value) => value)) : null;
      return tables.delete(
        'chat_project_memories',
        (r) => r.project_id === wanted && (!ids || ids.has(r.id))
      ).length;
    },
  };
}
