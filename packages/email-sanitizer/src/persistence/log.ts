/**
 * DB accessors for `email_classification_log` — the ONE table in this
 * package that carries message content (a bounded excerpt), and therefore
 * the one with a hard rule: every read here is scoped by `owner_upn`. There
 * is no function in this file that lists or searches across owners — that
 * is what keeps mail private to its owner. Admin-facing code must never
 * import this module; it uses `persistence/templates.ts`'s content-free
 * health summary instead.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { EmailCategory, MessageOverrideAction, SanitizeResult } from '../types';

export interface ClassificationLogEntry {
  tenantId: string;
  provider: string;
  refId: string;
  ownerUpn: string;
  /** The connector account/grant id for this owner — lets an override re-resolve access later. */
  accountId: string | null;
  result: SanitizeResult;
  contentHash: string | null;
  /** Bounded, owner-visible-only excerpt (subject/from/snippet) — never the full body. */
  excerpt: string;
}

export async function recordClassification(
  entry: ClassificationLogEntry
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const r = entry.result;
  const ownerUpn = entry.ownerUpn.toLowerCase();

  const shared = {
    category: r.category,
    matched_rule_id: r.matchedRuleId,
    sender_key: r.senderKey,
    template_id: r.action === 'index' ? r.templateId : null,
    template_version: r.action === 'index' ? r.templateVersion : null,
    match_score: r.action === 'index' ? r.matchScore : null,
    content_hash: entry.contentHash,
    needs_review: r.needsReview,
    excerpt: entry.excerpt,
  };

  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('email_classification_log')
        .values({
          id: randomUUID(),
          tenant_id: entry.tenantId,
          provider: entry.provider,
          ref_id: entry.refId,
          owner_upn: ownerUpn,
          account_id: entry.accountId,
          // created_at/updated_at are left to their column defaults on insert.
          ...shared,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'provider', 'ref_id'])
            .doUpdateSet({ ...shared, updated_at: sql<Date>`NOW()` })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}

/** Whether this exact cleaned content was already indexed for the tenant recently — exact-hash dedup only. */
export async function hasRecentDuplicate(
  tenantId: string,
  contentHash: string,
  lookbackDays: number
): Promise<Result<boolean, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_classification_log')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('content_hash', '=', contentHash)
        .where('created_at', '>=', sql<Date>`NOW() - ${lookbackDays} * INTERVAL '1 day'`)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;
  return ok(Boolean(rowResult.val));
}

export interface OwnClassificationRow {
  refId: string;
  provider: string;
  /** The connector account/grant id — needed to re-resolve access when applying an override. */
  accountId: string | null;
  category: string;
  senderKey: string | null;
  needsReview: boolean;
  matchScore: number | null;
  excerpt: string;
  overrideAction: string | null;
  createdAt: string;
}

const OWN_ROW_COLUMNS = [
  'ref_id',
  'provider',
  'account_id',
  'category',
  'sender_key',
  'needs_review',
  'match_score',
  'excerpt',
  'override_action',
  'created_at',
] as const;

interface OwnRowSelection {
  ref_id: string;
  provider: string;
  account_id: string | null;
  category: string;
  sender_key: string | null;
  needs_review: boolean;
  match_score: number | null;
  excerpt: string;
  override_action: string | null;
  created_at: unknown;
}

function toOwnRow(row: OwnRowSelection): OwnClassificationRow {
  return {
    refId: row.ref_id,
    provider: row.provider,
    accountId: row.account_id,
    category: row.category,
    senderKey: row.sender_key,
    needsReview: row.needs_review,
    matchScore: row.match_score,
    excerpt: row.excerpt,
    overrideAction: row.override_action,
    createdAt: String(row.created_at),
  };
}

export interface ListForOwnerOptions {
  category: EmailCategory;
  /** Page size — default 20. */
  limit?: number;
  /** Rows to skip — page 2 of size 20 is offset 20. */
  offset?: number;
}

export interface OwnClassificationPage {
  items: OwnClassificationRow[];
  /** Total rows in this category for this owner — drives page count client-side. */
  totalCount: number;
}

/**
 * One page of the caller's own messages, filtered to one category — the
 * only listing function in this module, and the only one that may ever back
 * a UI. `ownerUpn` must come from the caller's own resolved identity, never
 * from request input. Grouping by category server-side (rather than
 * fetching a flat recent-N and splitting client-side) matters here: an
 * owner with hundreds of excluded marketing messages and a handful of real
 * human ones must not have the marketing page crowd the human page out of a
 * shared limit.
 */
export async function listForOwner(
  tenantId: string,
  ownerUpn: string,
  options: ListForOwnerOptions
): Promise<Result<OwnClassificationPage, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const owner = ownerUpn.toLowerCase();

  const result = await wrapAsync(async () => {
    const rows = await db
      .selectFrom('email_classification_log')
      .select(OWN_ROW_COLUMNS)
      .where('tenant_id', '=', tenantId)
      .where('owner_upn', '=', owner)
      .where('category', '=', options.category)
      // Needs-review rows first — a spot check should surface the rare thing
      // that actually needs attention before the common case that doesn't.
      .orderBy('needs_review', 'desc')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    const countRow = await db
      .selectFrom('email_classification_log')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('owner_upn', '=', owner)
      .where('category', '=', options.category)
      .executeTakeFirst();

    return { items: rows.map(toOwnRow), totalCount: Number(countRow?.count ?? 0) };
  }, 'DB_ERROR' as const);

  return result;
}

export type CategoryCounts = Record<EmailCategory, number>;

/** How many of the caller's own messages fall in each category — drives the group tabs' counts. */
export async function countByCategoryForOwner(
  tenantId: string,
  ownerUpn: string
): Promise<Result<CategoryCounts, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowsResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_classification_log')
        .select('category')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', tenantId)
        .where('owner_upn', '=', ownerUpn.toLowerCase())
        .groupBy('category')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;

  const counts: CategoryCounts = { human: 0, system_notification: 0, marketing: 0 };
  for (const row of rowsResult.val) {
    if (
      row.category === 'human' ||
      row.category === 'system_notification' ||
      row.category === 'marketing'
    ) {
      counts[row.category] = Number(row.count);
    }
  }
  return ok(counts);
}

/**
 * One of the caller's own rows by refId — the server-side source of truth
 * for a message's provider/accountId when applying an override, so a route
 * handler never has to trust those fields from the client. Returns null for
 * a refId that does not belong to this owner, same as "not found" — that
 * ambiguity is deliberate, since confirming existence of another owner's
 * row would itself leak information.
 */
export async function getOwnRow(
  tenantId: string,
  ownerUpn: string,
  refId: string
): Promise<Result<OwnClassificationRow | null, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_classification_log')
        .select(OWN_ROW_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .where('owner_upn', '=', ownerUpn.toLowerCase())
        .where('ref_id', '=', refId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;
  const row = rowResult.val;
  return ok(row ? toOwnRow(row) : null);
}

export interface SetOverrideInput {
  action: MessageOverrideAction;
  category?: string;
  senderKey?: string;
}

/** Record the owner's correction. The caller (a worker event handler) applies it on reprocessing. */
export async function setOverride(
  tenantId: string,
  ownerUpn: string,
  refId: string,
  override: SetOverrideInput
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .updateTable('email_classification_log')
        .set({
          override_action: override.action,
          override_category: override.category ?? null,
          override_sender_key: override.senderKey ?? null,
          overridden_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('tenant_id', '=', tenantId)
        .where('owner_upn', '=', ownerUpn.toLowerCase())
        .where('ref_id', '=', refId)
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
