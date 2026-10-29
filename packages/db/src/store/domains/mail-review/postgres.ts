import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { OWN_ROW_COLUMNS, outcomeValues, ownRowFromRow } from './record';
import type { MailReviewStore } from './types';

export function postgresMailReview(db: () => Kysely<DB>): MailReviewStore {
  return {
    async record(entry) {
      const outcome = outcomeValues(entry);
      await db()
        .insertInto('email_classification_log')
        .values({
          id: entry.id,
          provider: entry.provider,
          ref_id: entry.refId,
          owner_upn: entry.ownerUpn,
          account_id: entry.accountId,
          // created_at/updated_at are left to their column defaults on insert.
          ...outcome,
        })
        .onConflict((oc) =>
          oc
            .columns(['provider', 'ref_id'])
            .doUpdateSet({ ...outcome, updated_at: sql<Date>`NOW()` })
        )
        .execute();
    },
    async hasIndexedDuplicate({ contentHash, ownerUpn, refId, lookbackDays }) {
      const row = await db()
        .selectFrom('email_classification_log')
        .select('id')
        .where('content_hash', '=', contentHash)
        .where('owner_upn', '=', ownerUpn)
        .where('ref_id', '<>', refId)
        .where('created_at', '>=', sql<Date>`NOW() - ${lookbackDays} * INTERVAL '1 day'`)
        .where(
          sql<boolean>`EXISTS (
            SELECT 1 FROM knowledge_chunks kc
            WHERE kc.provider = email_classification_log.provider
              AND (kc.ref_id = email_classification_log.ref_id
                   OR kc.ref_id LIKE email_classification_log.ref_id || '#%')
          )`
        )
        .executeTakeFirst();
      return Boolean(row);
    },
    async listForOwner(ownerUpn, category, { limit, offset }) {
      const rows = await db()
        .selectFrom('email_classification_log')
        .select(OWN_ROW_COLUMNS)
        .where('owner_upn', '=', ownerUpn)
        .where('category', '=', category)
        .orderBy('needs_review', 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .offset(offset)
        .execute();
      return rows.map(ownRowFromRow);
    },
    async countByCategory(ownerUpn) {
      const rows = await db()
        .selectFrom('email_classification_log')
        .select('category')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('owner_upn', '=', ownerUpn)
        .groupBy('category')
        .orderBy('category')
        .execute();
      return rows.map((row) => ({ category: row.category, count: Number(row.count) }));
    },
    async getOwnRow(ownerUpn, refId) {
      const row = await db()
        .selectFrom('email_classification_log')
        .select(OWN_ROW_COLUMNS)
        .where('owner_upn', '=', ownerUpn)
        .where('ref_id', '=', refId)
        .orderBy('provider')
        .orderBy('id')
        .executeTakeFirst();
      return row ? ownRowFromRow(row) : null;
    },
    async setOverride(ownerUpn, refId, { action, category, senderKey }) {
      const result = await db()
        .updateTable('email_classification_log')
        .set({
          override_action: action,
          override_category: category,
          override_sender_key: senderKey,
          overridden_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('owner_upn', '=', ownerUpn)
        .where('ref_id', '=', refId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async needsReviewCounts(lookbackDays) {
      const rows = await db()
        .selectFrom('email_classification_log')
        .select('sender_key')
        .select(({ fn }) => fn.countAll<string>().as('needs_review_count'))
        .where('needs_review', '=', true)
        .where('sender_key', 'is not', null)
        .where('created_at', '>=', sql<Date>`NOW() - ${lookbackDays} * INTERVAL '1 day'`)
        .groupBy('sender_key')
        .orderBy('sender_key')
        .execute();
      return rows.flatMap((row) =>
        row.sender_key === null
          ? []
          : [{ senderKey: row.sender_key, count: Number(row.needs_review_count) }]
      );
    },
    async suggestionEvidence(limit) {
      const corrected = await db()
        .selectFrom('email_classification_log')
        .select(['excerpt', 'category', 'override_category'])
        .where('override_category', 'is not', null)
        .orderBy('overridden_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .execute();
      const unsure =
        corrected.length < limit
          ? await db()
              .selectFrom('email_classification_log')
              .select(['excerpt', 'category'])
              .where('needs_review', '=', true)
              .where('override_category', 'is', null)
              .orderBy('created_at', 'desc')
              .orderBy('id')
              .limit(limit - corrected.length)
              .execute()
          : [];
      return {
        corrected: corrected.flatMap((row) =>
          row.override_category === null
            ? []
            : [
                {
                  excerpt: row.excerpt,
                  category: row.category,
                  overrideCategory: row.override_category,
                },
              ]
        ),
        unsure: unsure.map((row) => ({ excerpt: row.excerpt, category: row.category })),
      };
    },
  };
}
