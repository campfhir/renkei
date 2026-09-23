/**
 * The record of files the code pane opens without a language server
 * behind them — the `code_language_gaps` table (migration 123): one row
 * per (tenant, extension, language, reason), counted up on every open,
 * so which language to add a server for next is a query away. Nothing
 * reads it in the app; it is for the operator's SQL.
 *
 * Two reasons. `no_server`: the registry (packages/connector-sandbox/
 * src/lsp.ts) names no server for the file's language — the pane will
 * never have one until the registry grows. `not_installed`: the registry
 * names one, but this deployment's worker does not have it on its PATH
 * — the image, or a trimmed one, is what to look at. A file whose server
 * is there and running is not a gap and leaves no row.
 *
 * The write is fire-and-forget, after the file has been answered: a
 * slow or failed insert never costs the person their file. Which servers
 * the worker has is asked of it once a minute per process rather than
 * on every open.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { languageServerFor } from '@renkei/connector-sandbox';
import {
  sandboxWorkspacesEnabled,
  sbLspLanguages,
  type SandboxTarget,
} from '@renkei/sandbox-client';
import { logger } from '@/lib/logger';

export type LanguageGapReason = 'no_server' | 'not_installed';

const AVAILABILITY_TTL_MS = 60_000;

/**
 * The file's extension, lower-cased, or its whole name when it has none
 * (`Makefile`, `Dockerfile`) or is all extension (`.bashrc`) — the key
 * an operator groups by.
 */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : name;
  return extension.slice(0, 64);
}

/** Why a file of this language has no server, given what the worker has; null when it has one. */
export function gapReason(
  language: string,
  available: readonly string[]
): LanguageGapReason | null {
  const spec = languageServerFor(language);
  if (!spec) return 'no_server';
  return available.includes(spec.id) ? null : 'not_installed';
}

let availability: { at: number; languages: string[] } | null = null;

/** Which servers the worker can start, remembered for a minute; none when workspaces are off. */
async function availableServers(target: SandboxTarget): Promise<string[]> {
  if (!sandboxWorkspacesEnabled()) return [];
  const now = Date.now();
  if (availability && now - availability.at < AVAILABILITY_TTL_MS) return availability.languages;
  const listed = await sbLspLanguages(target);
  const languages = listed.ok ? listed.val : [];
  // A worker that could not be asked is not remembered as having nothing.
  if (listed.ok) availability = { at: now, languages };
  return languages;
}

/** Test-only: forget what the worker was last said to have. */
export function resetLanguageAvailabilityForTests(): void {
  availability = null;
}

export function noteLanguageGap(
  db: Kysely<DB>,
  input: { tenantId: string; target: SandboxTarget; path: string; language: string }
): void {
  void (async () => {
    const available = await availableServers(input.target);
    const reason = gapReason(input.language, available);
    if (!reason) return;
    await db
      .insertInto('code_language_gaps')
      .values({
        tenant_id: input.tenantId,
        extension: extensionOf(input.path),
        language: input.language.slice(0, 64),
        reason,
        sample_path: input.path.slice(0, 1_000),
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'extension', 'language', 'reason']).doUpdateSet({
          open_count: sql`code_language_gaps.open_count + 1`,
          last_seen_at: sql`now()`,
          sample_path: input.path.slice(0, 1_000),
        })
      )
      .execute();
  })().catch((error: unknown) => {
    logger.warn('language gap not recorded for {path}: {error}', {
      component: 'code/language-gaps',
      tenantId: input.tenantId,
      path: input.path,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
