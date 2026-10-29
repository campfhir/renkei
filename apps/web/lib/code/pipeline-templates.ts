/**
 * The catalog behind the Pipelines page's "start from a template"
 * picker (pipeline_templates, admin-managed at /admin/pipeline-templates)
 * — the project-templates idiom (project-templates.ts) for pipeline
 * files. Every tenant starts with a few seeded rows (migration 122) and
 * an operator can add, rewrite or delete any of them; there is no
 * separate "built-in" concept once seeded. Picking one only fills the
 * editor — the text is committed as the person leaves it — so a template
 * is a starting point to re-author, not a link the repository keeps.
 *
 * A template belongs to one host's catalog (`provider`): Bitbucket's
 * `bitbucket-pipelines.yml` today; a GitHub Actions workflow would be
 * another provider's rows in the same table.
 */

import { getDataStore } from '@renkei/db';
import { isUniqueViolation } from './project-templates';
import { ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
import { isUuid } from '@/lib/uuid';

export const PIPELINE_TEMPLATE_NAME_MAX_CHARS = 200;
export const PIPELINE_TEMPLATE_DESCRIPTION_MAX_CHARS = 300;
export const PIPELINE_TEMPLATE_BODY_MAX_CHARS = 60_000;

/** The hosts a template can be for; the one this ships with. */
export const PIPELINE_TEMPLATE_PROVIDERS: readonly string[] = [ATLASSIAN_BITBUCKET];

export interface PipelineTemplate {
  id: string;
  provider: string;
  name: string;
  description: string | null;
  body: string;
}

export async function listPipelineTemplates(provider?: string): Promise<PipelineTemplate[]> {
  return getDataStore().codeTemplates.listPipelineTemplates(provider);
}

export interface PipelineTemplateInput {
  provider: string;
  name: string;
  description: string | null;
  body: string;
}

export function parsePipelineTemplatePayload(
  body: unknown
): PipelineTemplateInput | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Malformed payload' };
  }
  const record: { provider?: unknown; name?: unknown; description?: unknown; body?: unknown } =
    body;
  const provider =
    typeof record.provider === 'string' && record.provider ? record.provider : ATLASSIAN_BITBUCKET;
  if (!PIPELINE_TEMPLATE_PROVIDERS.includes(provider)) {
    return { error: 'provider is not one a pipeline template can be for' };
  }
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name || name.length > PIPELINE_TEMPLATE_NAME_MAX_CHARS) {
    return { error: `name is required (at most ${PIPELINE_TEMPLATE_NAME_MAX_CHARS} characters)` };
  }
  const description =
    typeof record.description === 'string' && record.description.trim()
      ? record.description.trim().slice(0, PIPELINE_TEMPLATE_DESCRIPTION_MAX_CHARS)
      : null;
  // The body keeps its indentation and trailing newline: it is YAML.
  const text = typeof record.body === 'string' ? record.body.replace(/\r\n?/g, '\n') : '';
  if (!text.trim() || text.length > PIPELINE_TEMPLATE_BODY_MAX_CHARS) {
    return { error: `body is required (at most ${PIPELINE_TEMPLATE_BODY_MAX_CHARS} characters)` };
  }
  return { provider, name, description, body: text };
}

export async function createPipelineTemplate(
  input: PipelineTemplateInput
): Promise<{ ok: true; id: string } | { ok: false; error: 'duplicate' }> {
  try {
    return { ok: true, id: await getDataStore().codeTemplates.createPipelineTemplate(input) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'duplicate' };
    throw error;
  }
}

export async function updatePipelineTemplate(
  templateId: string,
  input: PipelineTemplateInput
): Promise<{ ok: true } | { ok: false; error: 'not-found' | 'duplicate' }> {
  if (!isUuid(templateId)) return { ok: false, error: 'not-found' };
  try {
    const updated = await getDataStore().codeTemplates.updatePipelineTemplate(templateId, input);
    return updated ? { ok: true } : { ok: false, error: 'not-found' };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'duplicate' };
    throw error;
  }
}

export async function deletePipelineTemplate(templateId: string): Promise<boolean> {
  if (!isUuid(templateId)) return false;
  return getDataStore().codeTemplates.deletePipelineTemplate(templateId);
}
