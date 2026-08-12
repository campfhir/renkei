/**
 * DB accessors for `email_banner_patterns` — a tenant-editable library of
 * literal "external sender" warning-banner phrases. Content-free the same
 * way `persistence/rules.ts` is: a phrase is boilerplate the org's own mail
 * infrastructure injects, never message content, so an org-admin route may
 * read and write it directly.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { BannerPattern } from '../types';

interface BannerRow {
  id: string;
  phrase: string;
  enabled: boolean;
}

function toBanner(row: BannerRow): BannerPattern {
  return { id: row.id, phrase: row.phrase, enabled: row.enabled };
}

export async function listBannerPatterns(
  tenantId: string
): Promise<Result<BannerPattern[], 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowsResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_banner_patterns')
        .select(['id', 'phrase', 'enabled'])
        .where('tenant_id', '=', tenantId)
        .orderBy('created_at', 'asc')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  return ok(rowsResult.val.map(toBanner));
}

/** Just the enabled phrases — what `sanitizeEmailForTenant` unions onto `SEED_BANNERS`. */
export async function listActiveBannerPatterns(
  tenantId: string
): Promise<Result<string[], 'DB_ERROR'>> {
  const result = await listBannerPatterns(tenantId);
  if (!result.ok) return result;
  return ok(result.val.filter((pattern) => pattern.enabled).map((pattern) => pattern.phrase));
}

export interface BannerPatternInput {
  id?: string;
  phrase: string;
  enabled: boolean;
}

export async function upsertBannerPattern(
  tenantId: string,
  pattern: BannerPatternInput
): Promise<Result<string, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const id = pattern.id ?? randomUUID();
  const phrase = pattern.phrase.trim();
  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('email_banner_patterns')
        .values({
          id,
          tenant_id: tenantId,
          phrase,
          enabled: pattern.enabled,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            phrase,
            enabled: pattern.enabled,
            updated_at: new Date().toISOString(),
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok(id);
}

export async function deleteBannerPattern(
  tenantId: string,
  id: string
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .deleteFrom('email_banner_patterns')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
