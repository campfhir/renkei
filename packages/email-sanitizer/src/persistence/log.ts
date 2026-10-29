/**
 * `email_classification_log`, through the data store
 * (`getDataStore().mailReview`) — the ONE table in this
 * package that carries message content (a bounded excerpt), and therefore
 * the one with a hard rule: every read here is scoped by `owner_upn`. There
 * is no function in this file that lists or searches across owners — that
 * is what keeps mail private to its owner. Admin-facing code must never
 * import this module; it uses `persistence/templates.ts`'s content-free
 * health summary instead.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type OwnClassificationRecord } from '@renkei/db';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { EmailCategory, MessageOverrideAction, SanitizeResult } from '../types';

export interface ClassificationLogEntry {
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
  const r = entry.result;
  const result = await wrapAsync(
    () =>
      getDataStore().mailReview.record({
        id: randomUUID(),
        provider: entry.provider,
        refId: entry.refId,
        ownerUpn: entry.ownerUpn.toLowerCase(),
        accountId: entry.accountId,
        category: r.category,
        matchedRuleId: r.matchedRuleId,
        senderKey: r.senderKey,
        templateId: r.action === 'index' ? r.templateId : null,
        templateVersion: r.action === 'index' ? r.templateVersion : null,
        matchScore: r.action === 'index' ? r.matchScore : null,
        contentHash: entry.contentHash,
        needsReview: r.needsReview,
        excerpt: entry.excerpt,
      }),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}

/**
 * Whether an equivalent message is CURRENTLY INDEXED for this mailbox —
 * exact-hash dedup.
 *
 * Scoped by owner and excluding the message itself. Tenant-wide it let one
 * person's mail suppress a colleague's identical copy of the same thread,
 * and — worse — a message re-processed by the re-index button matched its
 * OWN earlier log row and was dropped as a duplicate of itself.
 *
 * The EXISTS clause is the other half of that. The log outlives the index:
 * a rebuild purges chunks but keeps every log row, so a hash match alone
 * would answer "yes, seen before" for content that is no longer indexed at
 * all. Two byte-identical messages could then suppress each other into a
 * mailbox where neither exists. Dedup must mean "a copy is in the index
 * right now", not "we processed one of these once".
 */
export async function hasRecentDuplicate(
  contentHash: string,
  lookbackDays: number,
  scope: { ownerUpn: string; refId: string }
): Promise<Result<boolean, 'DB_ERROR'>> {
  return wrapAsync(
    () =>
      getDataStore().mailReview.hasIndexedDuplicate({
        contentHash,
        ownerUpn: scope.ownerUpn.toLowerCase(),
        refId: scope.refId,
        lookbackDays,
      }),
    'DB_ERROR' as const
  );
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

function toOwnRow(row: OwnClassificationRecord): OwnClassificationRow {
  return {
    refId: row.refId,
    provider: row.provider,
    accountId: row.accountId,
    category: row.category,
    senderKey: row.senderKey,
    needsReview: row.needsReview,
    matchScore: row.matchScore,
    excerpt: row.excerpt,
    overrideAction: row.overrideAction,
    createdAt: String(row.createdAt),
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
  ownerUpn: string,
  options: ListForOwnerOptions
): Promise<Result<OwnClassificationPage, 'DB_ERROR'>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const owner = ownerUpn.toLowerCase();

  return wrapAsync(async () => {
    const store = getDataStore();
    // Needs-review rows first — a spot check should surface the rare thing
    // that actually needs attention before the common case that doesn't.
    const rows = await store.mailReview.listForOwner(owner, options.category, { limit, offset });
    const counts = await store.mailReview.countByCategory(owner);
    const totalCount = counts.find((row) => row.category === options.category)?.count ?? 0;
    return { items: rows.map(toOwnRow), totalCount };
  }, 'DB_ERROR' as const);
}

export type CategoryCounts = Record<EmailCategory, number>;

/** How many of the caller's own messages fall in each category — drives the group tabs' counts. */
export async function countByCategoryForOwner(
  ownerUpn: string
): Promise<Result<CategoryCounts, 'DB_ERROR'>> {
  const rowsResult = await wrapAsync(
    () => getDataStore().mailReview.countByCategory(ownerUpn.toLowerCase()),
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
      counts[row.category] = row.count;
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
  ownerUpn: string,
  refId: string
): Promise<Result<OwnClassificationRow | null, 'DB_ERROR'>> {
  const rowResult = await wrapAsync(
    () => getDataStore().mailReview.getOwnRow(ownerUpn.toLowerCase(), refId),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;
  return ok(rowResult.val ? toOwnRow(rowResult.val) : null);
}

export interface SetOverrideInput {
  action: MessageOverrideAction;
  category?: string;
  senderKey?: string;
}

/** Record the owner's correction. The caller (a worker event handler) applies it on reprocessing. */
export async function setOverride(
  ownerUpn: string,
  refId: string,
  override: SetOverrideInput
): Promise<Result<void, 'DB_ERROR'>> {
  const result = await wrapAsync(
    () =>
      getDataStore().mailReview.setOverride(ownerUpn.toLowerCase(), refId, {
        action: override.action,
        category: override.category ?? null,
        senderKey: override.senderKey ?? null,
      }),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
