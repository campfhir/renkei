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

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
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

export async function listCodeProjectTemplates(
  db: Kysely<DB>,
  tenantId: string
): Promise<CodeProjectTemplate[]> {
  const rows = await db
    .selectFrom('code_project_templates')
    .select(['id', 'name', 'description', 'instructions'])
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
  }));
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
  db: Kysely<DB>,
  tenantId: string,
  input: TemplateInput
): Promise<{ ok: true; id: string } | { ok: false; error: 'duplicate' }> {
  try {
    const inserted = await db
      .insertInto('code_project_templates')
      .values({
        tenant_id: tenantId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { ok: true, id: inserted.id };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('idx_code_project_templates_tenant_name')
    ) {
      return { ok: false, error: 'duplicate' };
    }
    throw error;
  }
}

export async function updateCodeProjectTemplate(
  db: Kysely<DB>,
  tenantId: string,
  templateId: string,
  input: TemplateInput
): Promise<{ ok: true } | { ok: false; error: 'not-found' | 'duplicate' }> {
  if (!isUuid(templateId)) return { ok: false, error: 'not-found' };
  try {
    const result = await db
      .updateTable('code_project_templates')
      .set({
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        updated_at: sql`NOW()`,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return { ok: false, error: 'not-found' };
    return { ok: true };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('idx_code_project_templates_tenant_name')
    ) {
      return { ok: false, error: 'duplicate' };
    }
    throw error;
  }
}

export async function deleteCodeProjectTemplate(
  db: Kysely<DB>,
  tenantId: string,
  templateId: string
): Promise<boolean> {
  if (!isUuid(templateId)) return false;
  const result = await db
    .deleteFrom('code_project_templates')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', templateId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}
