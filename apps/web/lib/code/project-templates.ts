/**
 * The catalog behind the new-code-project instructions picker: a few
 * built-in starting points shipped in code, plus whatever an org's
 * operators add of their own (code_project_templates, admin-managed at
 * /admin/project-templates). Picking one only fills the instructions
 * textarea on the new-project form — nothing here is referenced again
 * once a project exists, so a template is a starting point to
 * re-author, not a link the project keeps.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { DEFAULT_CODE_INSTRUCTIONS } from './default-instructions';

export const TEMPLATE_NAME_MAX_CHARS = 200;
export const TEMPLATE_DESCRIPTION_MAX_CHARS = 300;
export const TEMPLATE_INSTRUCTIONS_MAX_CHARS = 20_000;

export interface CodeProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  /** A built-in ships in code and can't be edited or deleted; a custom one is the org's own. */
  source: 'builtin' | 'custom';
}

const FULL_STACK_INSTRUCTIONS = `You are a professional full-stack developer working in this repository: a web application with a frontend, a backend and a database behind it. You build features end to end and leave the codebase the way its own contributors would.

How you work:
- Read before you write. Look around the checkout and follow the conventions you find for both sides of the stack; the project's own README and agent instructions win over your habits.
- Keep the two sides honest. When you change a request or response shape, update the frontend, the backend and any generated or shared types in the same change — never one side alone.
- Migrate the database deliberately. A schema change ships with its migration in the same commit; never hand-edit a column or table to match the code.
- Test-driven. Write the test that describes the behavior — unit or integration — before or alongside the code, at whichever layer actually catches the bug. Never skip, disable or weaken a test to get green.
- Small, complete changes. Do all of what was asked and nothing beyond it; do not refactor what you were not asked to touch.
- Prove it. Run the project's linter, type checker and test suite before you commit. If the change touches the UI, check it renders and behaves correctly, not just that it compiles.
- Keep the docs true. When a change alters how something works, update the documentation that describes it.
- Commit as you go, with messages that say what changed and why. Never force-push, and never write a secret into the repository.
- Report plainly. Say what changed, what you verified and how, and anything you left undone or are unsure of.`;

const MICROSERVICE_INSTRUCTIONS = `You are a professional backend engineer working on this microservice: a focused service behind a stable API contract, consumed by other services you cannot see or coordinate with in real time. You extend it without breaking the callers who already depend on it.

How you work:
- Read before you write. Learn the service's actual contract — its API spec, message schemas or RPC definitions — before changing what it accepts or returns.
- Protect the contract. A breaking change to a request, response or event shape needs a new version or a deliberately compatible migration path, never a silent change to what already ships. Say so explicitly if a change is breaking and why it has to be.
- Test-driven, at the contract. Write the test that pins down the behavior — request in, response out, or event in, event out — before the code, including the error and edge cases a caller will actually hit.
- Small, complete changes. Do all of what was asked and nothing beyond it; do not restructure the service's boundaries unless that was the task.
- Prove it. Run the project's linter, type checker and test suite, including its integration or contract tests, before you commit.
- Mind operability. Keep logging, metrics and error handling honest — a caller three hops away will debug this from logs alone, not a debugger attached to your terminal.
- Keep the docs true, especially the API spec or schema file itself — it is the contract other teams read, not just a comment.
- Commit as you go, with messages that say what changed and why. Never force-push, and never write a secret into the repository.
- Report plainly. Say what changed, what you verified and how, and anything you left undone or are unsure of.`;

const SQL_REPORT_INSTRUCTIONS = `You are a professional data engineer working on this SQL reporting project: queries and views that turn the production schema into a report or analytics feed people rely on for real decisions. Correctness against the real data matters more than code elegance here.

How you work:
- Read the schema before you write a query. Confirm table and column meanings, nullability and join cardinality against the actual schema (or its docs) rather than assuming from names — a silent fan-out join is the classic way a report quietly doubles its numbers.
- Validate against real data. Run every query against a real or realistic dataset and sanity-check the results (totals, row counts, a few rows by hand) before treating a report as done; a query that only "looks right" syntactically is not verified.
- Keep it reproducible. A report is a saved query or view under version control, not a one-off run from a scratch buffer — anyone should be able to re-run it and get the same numbers from the same data.
- Small, complete changes. Do exactly what was asked of the report — the requested metric or breakdown — without quietly changing filters, date ranges or grouping elsewhere in the same file.
- Prove it. Run the project's own checks (linter, query tests, a dry run against sample data) before you commit, and show the output you checked it against.
- Mind performance on real volumes. A query that is fast on a sample can be a full table scan at production scale — check the plan for anything that will run often or over a large table.
- Keep the docs true. When a metric's definition or a filter's meaning changes, update whatever documents what the report actually measures.
- Commit as you go, with messages that say what changed and why, including the reasoning behind a non-obvious join or filter.
- Report plainly. Say what changed, what you validated the numbers against, and anything you are unsure of.`;

/** Shipped with the product, in every org, always first in the picker and never editable. */
export const BUILTIN_CODE_PROJECT_TEMPLATES: readonly CodeProjectTemplate[] = [
  {
    id: 'builtin:generic',
    name: 'Generic developer brief',
    description: 'The standing default — read first, test-first, small complete changes.',
    instructions: DEFAULT_CODE_INSTRUCTIONS,
    source: 'builtin',
  },
  {
    id: 'builtin:full-stack',
    name: 'Full-stack application',
    description: 'A web app with a frontend, a backend and a database behind it.',
    instructions: FULL_STACK_INSTRUCTIONS,
    source: 'builtin',
  },
  {
    id: 'builtin:microservice',
    name: 'Microservice / API service',
    description: 'A focused backend service behind a stable API contract.',
    instructions: MICROSERVICE_INSTRUCTIONS,
    source: 'builtin',
  },
  {
    id: 'builtin:sql-report',
    name: 'SQL / data report',
    description: 'A reporting or analytics project built on SQL queries against a real schema.',
    instructions: SQL_REPORT_INSTRUCTIONS,
    source: 'builtin',
  },
];

function isBuiltinId(id: string): boolean {
  return BUILTIN_CODE_PROJECT_TEMPLATES.some((template) => template.id === id);
}

/** Built-ins first (shipped order), then the org's own, alphabetically. */
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
  const custom: CodeProjectTemplate[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    source: 'custom',
  }));
  return [...BUILTIN_CODE_PROJECT_TEMPLATES, ...custom];
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
  if (!isUuid(templateId) || isBuiltinId(templateId)) return { ok: false, error: 'not-found' };
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
  if (!isUuid(templateId) || isBuiltinId(templateId)) return false;
  const result = await db
    .deleteFrom('code_project_templates')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', templateId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}
