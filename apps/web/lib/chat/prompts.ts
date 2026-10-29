/**
 * Prompt libraries and their prompts. Bodies are plaintext templates
 * meant for other people to read (migration 093); access is the shared
 * resolver's (owner / editor / viewer).
 */

import { getDataStore, type PromptLibraryRecord, type PromptRecord } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { listAccessibleProjectIds, listGrantedResources } from './access';

export const LIBRARY_NAME_MAX_CHARS = 200;
export const PROMPT_TITLE_MAX_CHARS = 200;
export const PROMPT_BODY_MAX_CHARS = 20_000;

export type LibraryRow = PromptLibraryRecord;
export type PromptRow = PromptRecord;

export async function getLibrary(libraryId: string): Promise<LibraryRow | null> {
  if (!isUuid(libraryId)) return null;
  return getDataStore().promptLibraries.get(libraryId);
}

/** Every library this person can open: theirs, and the ones shared with them. */
export async function listAccessibleLibraries(
  subject: string
): Promise<{ library: LibraryRow; role: 'owner' | 'editor' | 'viewer' }[]> {
  const store = getDataStore();
  const [owned, granted] = await Promise.all([
    store.promptLibraries.listOwned(subject),
    listGrantedResources(subject, 'prompt_library'),
  ]);
  const grantIds = granted.map((grant) => grant.resourceId).filter(isUuid);
  const grantedRows = grantIds.length > 0 ? await store.promptLibraries.listByIds(grantIds) : [];
  const roleByGrant = new Map(granted.map((grant) => [grant.resourceId, grant.role]));
  const seen = new Set<string>();
  const out: { library: LibraryRow; role: 'owner' | 'editor' | 'viewer' }[] = [];
  for (const library of owned) {
    seen.add(library.id);
    out.push({ library, role: 'owner' });
  }
  for (const library of grantedRows) {
    if (seen.has(library.id)) continue;
    seen.add(library.id);
    out.push({ library, role: roleByGrant.get(library.id) ?? 'viewer' });
  }
  return out;
}

export async function createLibrary(input: {
  ownerSubject: string;
  name: string;
  description: string | null;
}): Promise<string> {
  return getDataStore().promptLibraries.create(input);
}

export async function updateLibrary(
  libraryId: string,
  patch: { name?: string; description?: string | null }
): Promise<boolean> {
  if (!isUuid(libraryId)) return false;
  return getDataStore().promptLibraries.update(libraryId, patch);
}

export async function deleteLibrary(ownerSubject: string, libraryId: string): Promise<boolean> {
  if (!isUuid(libraryId)) return false;
  const store = getDataStore();
  const deleted = await store.promptLibraries.delete(ownerSubject, libraryId);
  if (deleted) await store.resourceGrants.deleteForResource('prompt_library', libraryId);
  return deleted;
}

export async function listPrompts(libraryId: string): Promise<PromptRow[]> {
  if (!isUuid(libraryId)) return [];
  return getDataStore().promptLibraries.listPrompts(libraryId);
}

export async function createPrompt(input: {
  libraryId: string;
  title: string;
  body: string;
  subject: string;
}): Promise<string> {
  return getDataStore().promptLibraries.createPrompt(input);
}

export async function updatePrompt(
  libraryId: string,
  promptId: string,
  patch: { title?: string; body?: string; position?: number },
  subject: string
): Promise<boolean> {
  if (!isUuid(libraryId) || !isUuid(promptId)) return false;
  return getDataStore().promptLibraries.updatePrompt(libraryId, promptId, patch, subject);
}

export async function deletePrompt(libraryId: string, promptId: string): Promise<boolean> {
  if (!isUuid(libraryId) || !isUuid(promptId)) return false;
  return getDataStore().promptLibraries.deletePrompt(libraryId, promptId);
}

/** The composer's picker: every prompt in every library this person can open. */
export async function listPickerPrompts(
  subject: string
): Promise<{ id: string; title: string; body: string; libraryName: string }[]> {
  const libraries = await listAccessibleLibraries(subject);
  if (libraries.length === 0) return [];
  const names = new Map(libraries.map((entry) => [entry.library.id, entry.library.name]));
  const rows = await getDataStore().promptLibraries.listPromptsIn([...names.keys()]);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    libraryName: names.get(row.libraryId) ?? '',
  }));
}

/** Convenience for the sidebar-free pages: project ids the person may open. */
export { listAccessibleProjectIds };
