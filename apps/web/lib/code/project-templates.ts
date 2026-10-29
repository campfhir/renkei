/**
 * The catalog behind the new-code-project instructions picker
 * (code_project_templates, admin-managed at /admin/project-templates).
 * Every tenant starts with a few seeded rows (migration 114) and an
 * operator can add, rewrite or delete any of them — there is no
 * separate "built-in" concept once seeded. Picking one only fills the
 * instructions textarea on the new-project form — nothing here is
 * referenced again once a project exists, so a template is a starting
 * point to re-author, not a link the project keeps.
 */

import { getDataStore } from '@renkei/db';
import { isUuid } from '@/lib/uuid';

export const TEMPLATE_NAME_MAX_CHARS = 200;
export const TEMPLATE_DESCRIPTION_MAX_CHARS = 300;
export const TEMPLATE_INSTRUCTIONS_MAX_CHARS = 20_000;

export interface CodeProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
}

export async function listCodeProjectTemplates(): Promise<CodeProjectTemplate[]> {
  return getDataStore().codeTemplates.listProjectTemplates();
}

/** A unique-name refusal (the store raises Postgres's 23505 for it). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export interface TemplateInput {
  name: string;
  description: string | null;
  instructions: string;
}

export function parseTemplatePayload(body: unknown): TemplateInput | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Malformed payload' };
  }
  const record: { name?: unknown; description?: unknown; instructions?: unknown } = body;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name || name.length > TEMPLATE_NAME_MAX_CHARS) {
    return { error: `name is required (at most ${TEMPLATE_NAME_MAX_CHARS} characters)` };
  }
  const description =
    typeof record.description === 'string' && record.description.trim()
      ? record.description.trim().slice(0, TEMPLATE_DESCRIPTION_MAX_CHARS)
      : null;
  const instructions = typeof record.instructions === 'string' ? record.instructions.trim() : '';
  if (!instructions || instructions.length > TEMPLATE_INSTRUCTIONS_MAX_CHARS) {
    return {
      error: `instructions is required (at most ${TEMPLATE_INSTRUCTIONS_MAX_CHARS} characters)`,
    };
  }
  return { name, description, instructions };
}

export async function createCodeProjectTemplate(
  input: TemplateInput
): Promise<{ ok: true; id: string } | { ok: false; error: 'duplicate' }> {
  try {
    return { ok: true, id: await getDataStore().codeTemplates.createProjectTemplate(input) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'duplicate' };
    throw error;
  }
}

export async function updateCodeProjectTemplate(
  templateId: string,
  input: TemplateInput
): Promise<{ ok: true } | { ok: false; error: 'not-found' | 'duplicate' }> {
  if (!isUuid(templateId)) return { ok: false, error: 'not-found' };
  try {
    const updated = await getDataStore().codeTemplates.updateProjectTemplate(templateId, input);
    return updated ? { ok: true } : { ok: false, error: 'not-found' };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'duplicate' };
    throw error;
  }
}

export async function deleteCodeProjectTemplate(templateId: string): Promise<boolean> {
  if (!isUuid(templateId)) return false;
  return getDataStore().codeTemplates.deleteProjectTemplate(templateId);
}
