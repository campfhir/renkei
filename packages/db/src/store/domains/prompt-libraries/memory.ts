import { orderBy } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { libraryFromRow, promptFromRow, promptPatchValues } from './record';
import type { PromptLibraryStore } from './types';

const newestFirst = (rows: Row<'prompt_libraries'>[]) =>
  orderBy(rows, [(r) => r.updated_at, 'desc'], [(r) => r.id]);

export function memoryPromptLibraries(tables: MemoryTables): PromptLibraryStore {
  const touch = (id: unknown) => {
    tables.update('prompt_libraries', (r) => r.id === id, { updated_at: new Date() });
  };

  return {
    async get(id) {
      const wanted = id;
      const row = tables.first('prompt_libraries', (r) => r.id === wanted);
      return row ? libraryFromRow(row) : null;
    },
    async listOwned(ownerSubject) {
      return newestFirst(
        tables.select('prompt_libraries', (r) => r.owner_subject === ownerSubject)
      ).map(libraryFromRow);
    },
    async listByIds(ids) {
      if (ids.length === 0) return [];
      const wanted = new Set(ids);
      return newestFirst(tables.select('prompt_libraries', (r) => wanted.has(r.id))).map(
        libraryFromRow
      );
    },
    async create(library) {
      return tables.insert('prompt_libraries', {
        owner_subject: library.ownerSubject,
        name: library.name,
        description: library.description,
        id: globalThis.crypto.randomUUID(),
        published_to_org: false,
        created_at: new Date(),
        updated_at: new Date(),
      }).id;
    },
    async update(id, patch) {
      const wanted = id;
      return (
        tables.update('prompt_libraries', (r) => r.id === wanted, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          updated_at: new Date(),
        }).length > 0
      );
    },
    async delete(ownerSubject, id) {
      const wanted = id;
      const deleted =
        tables.delete(
          'prompt_libraries',
          (r) => r.owner_subject === ownerSubject && r.id === wanted
        ).length > 0;
      if (deleted) tables.delete('prompts', (r) => r.library_id === wanted);
      return deleted;
    },
    async listPrompts(id) {
      const wanted = id;
      return orderBy(
        tables.select('prompts', (r) => r.library_id === wanted),
        [(r) => r.position],
        [(r) => r.created_at],
        [(r) => r.id]
      ).map(promptFromRow);
    },
    async listPromptsIn(ids) {
      if (ids.length === 0) return [];
      const wanted = new Set(ids);
      return orderBy(
        tables.select('prompts', (r) => wanted.has(r.library_id)),
        [(r) => r.library_id],
        [(r) => r.position],
        [(r) => r.id]
      ).map(promptFromRow);
    },
    async createPrompt(prompt) {
      const wanted = prompt.libraryId;
      const positions = tables
        .select('prompts', (r) => r.library_id === wanted)
        .map((r) => r.position);
      const inserted = tables.insert('prompts', {
        library_id: prompt.libraryId,
        title: prompt.title,
        body: prompt.body,
        position: Math.max(0, ...positions) + 1,
        created_by_subject: prompt.subject,
        updated_by_subject: prompt.subject,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      touch(wanted);
      return inserted.id;
    },
    async updatePrompt(id, prompt, patch, subject) {
      const library = id;
      const wanted = prompt;
      const updated =
        tables.update('prompts', (r) => r.library_id === library && r.id === wanted, {
          ...promptPatchValues(patch),
          updated_by_subject: subject,
          updated_at: new Date(),
        }).length > 0;
      if (updated) touch(library);
      return updated;
    },
    async deletePrompt(id, prompt) {
      const library = id;
      const wanted = prompt;
      const deleted =
        tables.delete('prompts', (r) => r.library_id === library && r.id === wanted).length > 0;
      if (deleted) touch(library);
      return deleted;
    },
  };
}
