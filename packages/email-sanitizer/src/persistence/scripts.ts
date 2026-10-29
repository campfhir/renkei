/**
 * `email_cleaner_scripts`, through the data store
 * (`getDataStore().emailSanitizer`) — tenant-editable sandboxed
 * cleaner functions. Content-free like classifier rules: a script is code the
 * admin wrote, never message content, so the admin route reads and writes
 * it directly. Execution lives in ../scripts/run.ts; this module only
 * stores the source and each script's health (`last_error`).
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { CleanerScriptKind } from '../scripts/run';

export interface CleanerScript {
  id: string;
  name: string;
  script: string;
  enabled: boolean;
  /**
   * The JavaScript the sandbox runs. Equals `script` when the admin wrote
   * plain JS; differs when they wrote TypeScript and the types were
   * stripped at save. Callers must run THIS, never `script`.
   */
  compiled: string;
  /**
   * The content kinds this script is allowed to touch. Never empty — a
   * script that runs on nothing is a disabled script, and the enabled flag
   * already says that.
   */
  appliesTo: CleanerScriptKind[];
  lastError: string | null;
}

const KINDS: readonly CleanerScriptKind[] = ['msg', 'evt'];

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

export async function listCleanerScripts(): Promise<Result<CleanerScript[], 'DB_ERROR'>> {
  const rowsResult = await wrapAsync(
    () => getDataStore().emailSanitizer.listScripts(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  return ok(
    rowsResult.val.map((row) => ({
      id: row.id,
      name: row.name,
      script: row.script,
      // Null on every row written before TypeScript was supported — those
      // are already JavaScript, so the source IS the runnable form.
      compiled: row.compiled ?? row.script,
      enabled: row.enabled,
      appliesTo: kindsOf(row.appliesTo),
      lastError: row.lastError,
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
  kind: CleanerScriptKind = 'msg'
): Promise<Result<CleanerScript[], 'DB_ERROR'>> {
  const result = await listCleanerScripts();
  if (!result.ok) return result;
  return ok(result.val.filter((script) => script.enabled && script.appliesTo.includes(kind)));
}

export interface CleanerScriptInput {
  id?: string;
  name: string;
  script: string;
  /** Type-stripped JavaScript. Omit when the source is already JavaScript. */
  compiled?: string | null;
  enabled: boolean;
  /** Omitted means mail only — the conservative reading of an older client. */
  appliesTo?: CleanerScriptKind[];
}

export async function upsertCleanerScript(
  input: CleanerScriptInput
): Promise<Result<CleanerScript, 'DB_ERROR'>> {
  const id = input.id ?? randomUUID();
  const stored = {
    id,
    name: input.name,
    script: input.script,
    compiled: input.compiled ?? null,
    enabled: input.enabled,
    appliesTo: kindsOf(input.appliesTo ?? null),
  };
  const saved = await wrapAsync(async () => {
    const store = getDataStore();
    // An edited script starts with a clean bill of health — its old error
    // described code that no longer exists (updateScript clears it).
    if (input.id) await store.emailSanitizer.updateScript(stored);
    else await store.emailSanitizer.insertScript(stored);
  }, 'DB_ERROR' as const);
  if (!saved.ok) return saved;
  return ok({
    id,
    name: input.name,
    script: input.script,
    compiled: input.compiled ?? input.script,
    enabled: input.enabled,
    appliesTo: kindsOf(input.appliesTo ?? null),
    lastError: null,
  });
}

export async function deleteCleanerScript(id: string): Promise<Result<void, 'DB_ERROR'>> {
  const deleted = await wrapAsync(
    () => getDataStore().emailSanitizer.deleteScript(id),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok();
}

/** Best-effort health write; a failure here must never block mail flow. */
export async function recordCleanerScriptError(id: string, error: string | null): Promise<void> {
  await wrapAsync(
    () => getDataStore().emailSanitizer.setScriptError(id, error),
    'DB_ERROR' as const
  );
}
