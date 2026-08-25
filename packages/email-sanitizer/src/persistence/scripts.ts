/**
 * DB accessors for `email_cleaner_scripts` — tenant-editable sandboxed
 * cleaner functions. Content-free like classifier rules: a script is code the
 * admin wrote, never message content, so the admin route reads and writes
 * it directly. Execution lives in ../scripts/run.ts; this module only
 * stores the source and each script's health (`last_error`).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { CleanerScriptKind } from '../scripts/run';

export interface CleanerScript {
  id: string;
  name: string;
  script: string;
  enabled: boolean;
  /**
   * The content kinds this script is allowed to touch. Never empty — a
   * script that runs on nothing is a disabled script, and the enabled flag
   * already says that.
   */
  appliesTo: CleanerScriptKind[];
  lastError: string | null;
}

const KINDS: readonly CleanerScriptKind[] = ['msg', 'evt', 'task'];

function isKind(value: string): value is CleanerScriptKind {
  return KINDS.some((kind) => kind === value);
}

/**
 * Kinds as stored, narrowed to the ones this build knows.
 *
 * A row written by a newer deploy can name a kind this one has never heard
 * of; dropping it here means an old worker simply does not run that script
 * on that kind, rather than passing an unknown string into the stage. Falls
 * back to mail — the behaviour every row had before the column existed.
 */
function kindsOf(stored: readonly string[] | null): CleanerScriptKind[] {
  const known = (stored ?? []).filter(isKind);
  return known.length > 0 ? known : ['msg'];
}

export async function listCleanerScripts(
  tenantId: string
): Promise<Result<CleanerScript[], 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowsResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_cleaner_scripts')
        .select(['id', 'name', 'script', 'enabled', 'applies_to', 'last_error'])
        .where('tenant_id', '=', tenantId)
        .orderBy('created_at', 'asc')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  return ok(
    rowsResult.val.map((row) => ({
      id: row.id,
      name: row.name,
      script: row.script,
      enabled: row.enabled,
      appliesTo: kindsOf(row.applies_to),
      lastError: row.last_error,
    }))
  );
}

/**
 * Enabled scripts for one content kind, in creation order — the pipeline
 * runs them in sequence.
 *
 * The kind argument defaults to mail so the original call site, and any
 * caller that predates invites reaching this stage, keeps its exact
 * behaviour.
 */
export async function listActiveCleanerScripts(
  tenantId: string,
  kind: CleanerScriptKind = 'msg'
): Promise<Result<CleanerScript[], 'DB_ERROR'>> {
  const result = await listCleanerScripts(tenantId);
  if (!result.ok) return result;
  return ok(result.val.filter((script) => script.enabled && script.appliesTo.includes(kind)));
}

export interface CleanerScriptInput {
  id?: string;
  name: string;
  script: string;
  enabled: boolean;
  /** Omitted means mail only — the conservative reading of an older client. */
  appliesTo?: CleanerScriptKind[];
}

export async function upsertCleanerScript(
  tenantId: string,
  input: CleanerScriptInput
): Promise<Result<CleanerScript, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const id = input.id ?? randomUUID();
  const saved = await wrapAsync(async () => {
    if (input.id) {
      await dbResult.val
        .updateTable('email_cleaner_scripts')
        .set({
          name: input.name,
          script: input.script,
          enabled: input.enabled,
          applies_to: kindsOf(input.appliesTo ?? null),
          // An edited script starts with a clean bill of health — its old
          // error described code that no longer exists.
          last_error: null,
          updated_at: sql`now()`,
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', input.id)
        .execute();
    } else {
      await dbResult.val
        .insertInto('email_cleaner_scripts')
        .values({
          id,
          tenant_id: tenantId,
          name: input.name,
          script: input.script,
          enabled: input.enabled,
          applies_to: kindsOf(input.appliesTo ?? null),
        })
        .execute();
    }
  }, 'DB_ERROR' as const);
  if (!saved.ok) return saved;
  return ok({
    id,
    name: input.name,
    script: input.script,
    enabled: input.enabled,
    appliesTo: kindsOf(input.appliesTo ?? null),
    lastError: null,
  });
}

export async function deleteCleanerScript(
  tenantId: string,
  id: string
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const deleted = await wrapAsync(
    () =>
      dbResult.val
        .deleteFrom('email_cleaner_scripts')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .execute(),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok();
}

/** Best-effort health write; a failure here must never block mail flow. */
export async function recordCleanerScriptError(
  tenantId: string,
  id: string,
  error: string | null
): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  await wrapAsync(
    () =>
      dbResult.val
        .updateTable('email_cleaner_scripts')
        .set({ last_error: error, updated_at: sql`now()` })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .execute(),
    'DB_ERROR' as const
  );
}
