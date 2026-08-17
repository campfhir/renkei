/**
 * DB accessors for `email_cleaner_scripts` — tenant-editable sandboxed
 * cleaner functions. Content-free like rules/banners: a script is code the
 * admin wrote, never message content, so the admin route reads and writes
 * it directly. Execution lives in ../scripts/run.ts; this module only
 * stores the source and each script's health (`last_error`).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface CleanerScript {
  id: string;
  name: string;
  script: string;
  enabled: boolean;
  lastError: string | null;
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
        .select(['id', 'name', 'script', 'enabled', 'last_error'])
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
      lastError: row.last_error,
    }))
  );
}

/** Enabled scripts in creation order — the pipeline runs them in sequence. */
export async function listActiveCleanerScripts(
  tenantId: string
): Promise<Result<CleanerScript[], 'DB_ERROR'>> {
  const result = await listCleanerScripts(tenantId);
  if (!result.ok) return result;
  return ok(result.val.filter((script) => script.enabled));
}

export interface CleanerScriptInput {
  id?: string;
  name: string;
  script: string;
  enabled: boolean;
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
