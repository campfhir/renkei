import type { Selectable } from 'kysely';
import type { PromptLibraries, Prompts } from '../../../db.types';
import type { PromptLibraryRecord, PromptRecord } from './types';

export function libraryFromRow(row: Selectable<PromptLibraries>): PromptLibraryRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    name: row.name,
    description: row.description,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function promptFromRow(row: Selectable<Prompts>): PromptRecord {
  return {
    id: row.id,
    libraryId: row.library_id,
    title: row.title,
    body: row.body,
    position: row.position,
    createdBySubject: row.created_by_subject,
    updatedBySubject: row.updated_by_subject,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function promptPatchValues(patch: { title?: string; body?: string; position?: number }) {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
  };
}
