/**
 * Prompt libraries and their prompts. Bodies are plaintext templates
 * meant for other people to read (migration 093); access is the shared
 * resolver's (owner / editor / viewer / published).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { listAccessibleProjectIds, listGrantedResources } from './access';

export const LIBRARY_NAME_MAX_CHARS = 200;
export const PROMPT_TITLE_MAX_CHARS = 200;
export const PROMPT_BODY_MAX_CHARS = 20_000;

export interface LibraryRow {
  id: string;
  ownerSubject: string;
  name: string;
  description: string | null;
  publishedToOrg: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromptRow {
  id: string;
  libraryId: string;
  title: string;
  body: string;
  position: number;
  createdBySubject: string;
  updatedBySubject: string;
  createdAt: Date;
  updatedAt: Date;
}

const LIBRARY_COLUMNS = [
  'id',
  'owner_subject',
  'name',
  'description',
  'published_to_org',
  'created_at',
  'updated_at',
] as const;

function libraryOf(raw: {
  id: string;
  owner_subject: string;
  name: string;
  description: string | null;
  published_to_org: boolean;
  created_at: Date;
  updated_at: Date;
}): LibraryRow {
  return {
    id: raw.id,
    ownerSubject: raw.owner_subject,
    name: raw.name,
    description: raw.description,
    publishedToOrg: raw.published_to_org,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function promptOf(raw: {
  id: string;
  library_id: string;
  title: string;
  body: string;
  position: number;
  created_by_subject: string;
  updated_by_subject: string;
  created_at: Date;
  updated_at: Date;
}): PromptRow {
  return {
    id: raw.id,
    libraryId: raw.library_id,
    title: raw.title,
    body: raw.body,
    position: raw.position,
    createdBySubject: raw.created_by_subject,
    updatedBySubject: raw.updated_by_subject,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export async function getLibrary(
  db: Kysely<DB>,
  tenantId: string,
  libraryId: string
): Promise<LibraryRow | null> {
  if (!isUuid(libraryId)) return null;
  const raw = await db
    .selectFrom('prompt_libraries')
    .select(LIBRARY_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', libraryId)
    .executeTakeFirst();
  return raw ? libraryOf(raw) : null;
}

/** Every library this person can open: theirs, shared with them, published. */
export async function listAccessibleLibraries(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<{ library: LibraryRow; role: 'owner' | 'editor' | 'viewer' }[]> {
  const [owned, granted, published] = await Promise.all([
    db
      .selectFrom('prompt_libraries')
      .select(LIBRARY_COLUMNS)
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', subject)
      .orderBy('updated_at', 'desc')
      .execute(),
    listGrantedResources(db, tenantId, subject, 'prompt_library'),
    db
      .selectFrom('prompt_libraries')
      .select(LIBRARY_COLUMNS)
      .where('tenant_id', '=', tenantId)
      .where('published_to_org', '=', true)
      .where('owner_subject', '!=', subject)
      .orderBy('updated_at', 'desc')
      .execute(),
  ]);
  const grantIds = granted.map((grant) => grant.resourceId).filter(isUuid);
  const grantedRows =
    grantIds.length > 0
      ? await db
          .selectFrom('prompt_libraries')
          .select(LIBRARY_COLUMNS)
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', grantIds)
          .execute()
      : [];
  const roleByGrant = new Map(granted.map((grant) => [grant.resourceId, grant.role]));
  const seen = new Set<string>();
  const out: { library: LibraryRow; role: 'owner' | 'editor' | 'viewer' }[] = [];
  for (const raw of owned) {
    seen.add(raw.id);
    out.push({ library: libraryOf(raw), role: 'owner' });
  }
  for (const raw of grantedRows) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push({ library: libraryOf(raw), role: roleByGrant.get(raw.id) ?? 'viewer' });
  }
  for (const raw of published) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push({ library: libraryOf(raw), role: 'viewer' });
  }
  return out;
}

export async function createLibrary(
  db: Kysely<DB>,
  input: { tenantId: string; ownerSubject: string; name: string; description: string | null }
): Promise<string> {
  const inserted = await db
    .insertInto('prompt_libraries')
    .values({
      tenant_id: input.tenantId,
      owner_subject: input.ownerSubject,
      name: input.name,
      description: input.description,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

export async function updateLibrary(
  db: Kysely<DB>,
  tenantId: string,
  libraryId: string,
  patch: { name?: string; description?: string | null; publishedToOrg?: boolean }
): Promise<boolean> {
  if (!isUuid(libraryId)) return false;
  const result = await db
    .updateTable('prompt_libraries')
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.publishedToOrg !== undefined ? { published_to_org: patch.publishedToOrg } : {}),
      updated_at: sql<Date>`NOW()`,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', libraryId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function deleteLibrary(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  libraryId: string
): Promise<boolean> {
  if (!isUuid(libraryId)) return false;
  const result = await db
    .deleteFrom('prompt_libraries')
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', libraryId)
    .executeTakeFirst();
  const deleted = Number(result.numDeletedRows) > 0;
  if (deleted) {
    await db
      .deleteFrom('resource_access_grants')
      .where('tenant_id', '=', tenantId)
      .where('resource_kind', '=', 'prompt_library')
      .where('resource_id', '=', libraryId)
      .execute();
  }
  return deleted;
}

export async function listPrompts(
  db: Kysely<DB>,
  tenantId: string,
  libraryId: string
): Promise<PromptRow[]> {
  if (!isUuid(libraryId)) return [];
  const rows = await db
    .selectFrom('prompts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('library_id', '=', libraryId)
    .orderBy('position', 'asc')
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(promptOf);
}

export async function createPrompt(
  db: Kysely<DB>,
  input: { tenantId: string; libraryId: string; title: string; body: string; subject: string }
): Promise<string> {
  const inserted = await db
    .insertInto('prompts')
    .values({
      tenant_id: input.tenantId,
      library_id: input.libraryId,
      title: input.title,
      body: input.body,
      position: sql<number>`(SELECT COALESCE(MAX(position), 0) + 1 FROM prompts WHERE library_id = ${input.libraryId})`,
      created_by_subject: input.subject,
      updated_by_subject: input.subject,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await touchLibrary(db, input.libraryId);
  return inserted.id;
}

export async function updatePrompt(
  db: Kysely<DB>,
  tenantId: string,
  libraryId: string,
  promptId: string,
  patch: { title?: string; body?: string; position?: number },
  subject: string
): Promise<boolean> {
  if (!isUuid(libraryId) || !isUuid(promptId)) return false;
  const result = await db
    .updateTable('prompts')
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      updated_by_subject: subject,
      updated_at: sql<Date>`NOW()`,
    })
    .where('tenant_id', '=', tenantId)
    .where('library_id', '=', libraryId)
    .where('id', '=', promptId)
    .executeTakeFirst();
  const updated = Number(result.numUpdatedRows) > 0;
  if (updated) await touchLibrary(db, libraryId);
  return updated;
}

export async function deletePrompt(
  db: Kysely<DB>,
  tenantId: string,
  libraryId: string,
  promptId: string
): Promise<boolean> {
  if (!isUuid(libraryId) || !isUuid(promptId)) return false;
  const result = await db
    .deleteFrom('prompts')
    .where('tenant_id', '=', tenantId)
    .where('library_id', '=', libraryId)
    .where('id', '=', promptId)
    .executeTakeFirst();
  const deleted = Number(result.numDeletedRows) > 0;
  if (deleted) await touchLibrary(db, libraryId);
  return deleted;
}

async function touchLibrary(db: Kysely<DB>, libraryId: string): Promise<void> {
  await db
    .updateTable('prompt_libraries')
    .set({ updated_at: sql<Date>`NOW()` })
    .where('id', '=', libraryId)
    .execute();
}

/** The composer's picker: every prompt in every library this person can open. */
export async function listPickerPrompts(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<{ id: string; title: string; body: string; libraryName: string }[]> {
  const libraries = await listAccessibleLibraries(db, tenantId, subject);
  if (libraries.length === 0) return [];
  const names = new Map(libraries.map((entry) => [entry.library.id, entry.library.name]));
  const rows = await db
    .selectFrom('prompts')
    .select(['id', 'library_id', 'title', 'body'])
    .where('tenant_id', '=', tenantId)
    .where('library_id', 'in', [...names.keys()])
    .orderBy('library_id')
    .orderBy('position', 'asc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    libraryName: names.get(row.library_id) ?? '',
  }));
}

/** Convenience for the sidebar-free pages: project ids the person may open. */
export { listAccessibleProjectIds };
