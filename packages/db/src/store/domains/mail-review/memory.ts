import { groupBy, like, orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { DAY_MS, outcomeValues, ownRowFromRow } from './record';
import type { MailReviewStore } from './types';

export function memoryMailReview(tables: MemoryTables): MailReviewStore {
  const since = (lookbackDays: number) => Date.now() - lookbackDays * DAY_MS;
  return {
    async record(entry) {
      const outcome = outcomeValues(entry);
      tables.upsert(
        'email_classification_log',
        {
          id: entry.id,
          provider: entry.provider,
          ref_id: entry.refId,
          owner_upn: entry.ownerUpn,
          account_id: entry.accountId,
          ...outcome,
          override_action: null,
          override_category: null,
          override_sender_key: null,
          overridden_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
        ['provider', 'ref_id'],
        { ...outcome, updated_at: new Date() }
      );
    },
    async hasIndexedDuplicate({ contentHash, ownerUpn, refId, lookbackDays }) {
      const cutoff = since(lookbackDays);
      const chunks = tables.select('knowledge_chunks');
      return tables
        .select(
          'email_classification_log',
          (r) =>
            r.content_hash === contentHash &&
            r.owner_upn === ownerUpn &&
            r.ref_id !== refId &&
            r.created_at.getTime() >= cutoff
        )
        .some((log) =>
          chunks.some(
            (kc) =>
              kc.provider === log.provider &&
              // `LIKE ref_id || '#%'`: the ref id's own % and _ are wildcards there too.
              (kc.ref_id === log.ref_id || like(kc.ref_id, `${log.ref_id}#%`, true))
          )
        );
    },
    async listForOwner(ownerUpn, category, { limit, offset }) {
      const rows = tables.select(
        'email_classification_log',
        (r) => r.owner_upn === ownerUpn && r.category === category
      );
      return page(
        orderBy(
          rows,
          [(r) => r.needs_review, 'desc'],
          [(r) => r.created_at, 'desc'],
          [(r) => r.id]
        ),
        limit,
        offset
      ).map(ownRowFromRow);
    },
    async countByCategory(ownerUpn) {
      const groups = groupBy(
        tables.select('email_classification_log', (r) => r.owner_upn === ownerUpn),
        (r) => r.category
      );
      return orderBy([...groups.entries()], [([category]) => category]).map(([category, rows]) => ({
        category,
        count: rows.length,
      }));
    },
    async getOwnRow(ownerUpn, refId) {
      const [row] = orderBy(
        tables.select(
          'email_classification_log',
          (r) => r.owner_upn === ownerUpn && r.ref_id === refId
        ),
        [(r) => r.provider],
        [(r) => r.id]
      );
      return row ? ownRowFromRow(row) : null;
    },
    async setOverride(ownerUpn, refId, { action, category, senderKey }) {
      const now = new Date();
      return tables.update(
        'email_classification_log',
        (r) => r.owner_upn === ownerUpn && r.ref_id === refId,
        {
          override_action: action,
          override_category: category,
          override_sender_key: senderKey,
          overridden_at: now,
          updated_at: now,
        }
      ).length;
    },
    async needsReviewCounts(lookbackDays) {
      const cutoff = since(lookbackDays);
      const groups = groupBy(
        tables.select(
          'email_classification_log',
          (r) => r.needs_review && r.sender_key !== null && r.created_at.getTime() >= cutoff
        ),
        (r) => r.sender_key ?? ''
      );
      return orderBy([...groups.entries()], [([key]) => key]).map(([senderKey, rows]) => ({
        senderKey,
        count: rows.length,
      }));
    },
    async suggestionEvidence(limit) {
      const corrected = page(
        orderBy(
          tables.select('email_classification_log', (r) => r.override_category !== null),
          [(r) => r.overridden_at, 'desc'],
          [(r) => r.id]
        ),
        limit
      );
      const unsure =
        corrected.length < limit
          ? page(
              orderBy(
                tables.select(
                  'email_classification_log',
                  (r) => r.needs_review && r.override_category === null
                ),
                [(r) => r.created_at, 'desc'],
                [(r) => r.id]
              ),
              limit - corrected.length
            )
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
