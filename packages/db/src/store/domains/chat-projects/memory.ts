import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import {
  newProjectValues,
  projectFromRow,
  projectMemoryFromRow,
  projectPatchValues,
} from './record';
import type { ChatProjectStore } from './types';

export function memoryChatProjects(tables: MemoryTables): ChatProjectStore {
  const projectId = (value: string) => tables.param('chat_projects', 'id', value);
  const memoryRows = (id: unknown) =>
    orderBy(
      tables.select('chat_project_memories', (r) => r.project_id === id),
      [(r) => r.created_at, 'desc'],
      [(r) => r.id]
    );

  return {
    async get(id) {
      const wanted = projectId(id);
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
      const ids = new Set(projectIds.map(projectId));
      const rows = tables.select('chat_projects', (r) => ids.has(r.id));
      const sorted =
        options.orderBy === 'name'
          ? orderBy(rows, [(r) => r.name], [(r) => r.id])
          : orderBy(rows, [(r) => r.updated_at, 'desc'], [(r) => r.id]);
      return sorted.map(projectFromRow);
    },
    async create(project) {
      return tables.insert('chat_projects', newProjectValues(project)).id;
    },
    async update(id, patch) {
      const wanted = projectId(id);
      return (
        tables.update('chat_projects', (r) => r.id === wanted, {
          ...projectPatchValues(patch),
          updated_at: new Date(),
        }).length > 0
      );
    },
    async delete(ownerSubject, id) {
      const wanted = projectId(id);
      return (
        tables.delete('chat_projects', (r) => r.owner_subject === ownerSubject && r.id === wanted)
          .length > 0
      );
    },
    async listMemory(id, limit) {
      return page(memoryRows(projectId(id)), limit).map(projectMemoryFromRow);
    },
    async appendMemory(entry) {
      const inserted = tables.insert('chat_project_memories', {
        project_id: entry.projectId,
        kind: 'entry',
        content: entry.content,
        author_subject: entry.authorSubject,
        chat_id: entry.chatId,
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
      const wanted = projectId(id);
      const ids =
        target.kind === 'entries'
          ? new Set(target.ids.map((value) => tables.param('chat_project_memories', 'id', value)))
          : null;
      return tables.delete(
        'chat_project_memories',
        (r) => r.project_id === wanted && (!ids || ids.has(r.id))
      ).length;
    },
  };
}
