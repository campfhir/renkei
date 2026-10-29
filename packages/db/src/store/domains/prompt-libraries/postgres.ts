import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { libraryFromRow, promptFromRow, promptPatchValues } from './record';
import type { PromptLibraryStore } from './types';

export function postgresPromptLibraries(db: () => Kysely<DB>): PromptLibraryStore {
  const touch = async (libraryId: string) => {
    await db()
      .updateTable('prompt_libraries')
      .set({ updated_at: sql<Date>`NOW()` })
      .where('id', '=', libraryId)
      .execute();
  };
  return {
    async get(libraryId) {
      const row = await db()
        .selectFrom('prompt_libraries')
        .selectAll()
        .where('id', '=', libraryId)
        .executeTakeFirst();
      return row ? libraryFromRow(row) : null;
    },
    async listOwned(ownerSubject) {
      const rows = await db()
        .selectFrom('prompt_libraries')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .execute();
      return rows.map(libraryFromRow);
    },
    async listByIds(libraryIds) {
      if (libraryIds.length === 0) return [];
      const rows = await db()
        .selectFrom('prompt_libraries')
        .selectAll()
        .where('id', 'in', libraryIds)
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .execute();
      return rows.map(libraryFromRow);
    },
    async create(library) {
      const inserted = await db()
        .insertInto('prompt_libraries')
        .values({
          owner_subject: library.ownerSubject,
          name: library.name,
          description: library.description,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return inserted.id;
    },
    async update(libraryId, patch) {
      const result = await db()
        .updateTable('prompt_libraries')
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          updated_at: sql<Date>`NOW()`,
        })
        .where('id', '=', libraryId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async delete(ownerSubject, libraryId) {
      const result = await db()
        .deleteFrom('prompt_libraries')
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', libraryId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
    async listPrompts(libraryId) {
      const rows = await db()
        .selectFrom('prompts')
        .selectAll()
        .where('library_id', '=', libraryId)
        .orderBy('position', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(promptFromRow);
    },
    async listPromptsIn(libraryIds) {
      if (libraryIds.length === 0) return [];
      const rows = await db()
        .selectFrom('prompts')
        .selectAll()
        .where('library_id', 'in', libraryIds)
        .orderBy('library_id')
        .orderBy('position', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(promptFromRow);
    },
    async createPrompt(prompt) {
      const inserted = await db()
        .insertInto('prompts')
        .values({
          library_id: prompt.libraryId,
          title: prompt.title,
          body: prompt.body,
          position: sql<number>`(SELECT COALESCE(MAX(position), 0) + 1 FROM prompts WHERE library_id = ${prompt.libraryId})`,
          created_by_subject: prompt.subject,
          updated_by_subject: prompt.subject,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await touch(prompt.libraryId);
      return inserted.id;
    },
    async updatePrompt(libraryId, promptId, patch, subject) {
      const result = await db()
        .updateTable('prompts')
        .set({
          ...promptPatchValues(patch),
          updated_by_subject: subject,
          updated_at: sql<Date>`NOW()`,
        })
        .where('library_id', '=', libraryId)
        .where('id', '=', promptId)
        .executeTakeFirst();
      const updated = Number(result.numUpdatedRows) > 0;
      if (updated) await touch(libraryId);
      return updated;
    },
    async deletePrompt(libraryId, promptId) {
      const result = await db()
        .deleteFrom('prompts')
        .where('library_id', '=', libraryId)
        .where('id', '=', promptId)
        .executeTakeFirst();
      const deleted = Number(result.numDeletedRows) > 0;
      if (deleted) await touch(libraryId);
      return deleted;
    },
  };
}
