import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { actionableItemFromRow, itemPatchValues, newItemValues } from './record';
import type { ActionableItemStore } from './types';

/** Tenant-wide (no owner) or the subject's own. */
function visibleTo(subject: string) {
  return (eb: ExpressionBuilder<DB, 'actionable_items'>) =>
    eb.or([
      eb('actionable_items.owner_subject', 'is', null),
      eb('actionable_items.owner_subject', '=', subject),
    ]);
}

export function postgresActionableItems(db: () => Kysely<DB>): ActionableItemStore {
  const withAgent = () =>
    db()
      .selectFrom('actionable_items')
      .leftJoin('agents', 'agents.id', 'actionable_items.created_by_agent_id')
      .selectAll('actionable_items')
      .select('agents.name as agent_name');

  return {
    async listVisible(subject, { limit, offset = 0, includeArchived, status }) {
      let query = withAgent()
        .where(visibleTo(subject))
        .orderBy('actionable_items.created_at', 'desc')
        .orderBy('actionable_items.id')
        .limit(limit)
        .offset(offset);
      if (!includeArchived) query = query.where('actionable_items.archived_at', 'is', null);
      if (status !== undefined) query = query.where('actionable_items.status', '=', status);
      const rows = await query.execute();
      return rows.map(({ agent_name, ...row }) => actionableItemFromRow(row, agent_name));
    },
    async findVisible(subject, id) {
      const row = await withAgent()
        .where('actionable_items.id', '=', id)
        .where(visibleTo(subject))
        .executeTakeFirst();
      if (!row) return null;
      const { agent_name, ...item } = row;
      return actionableItemFromRow(item, agent_name);
    },
    async archive(id, by) {
      await db()
        .updateTable('actionable_items')
        .set({ archived_at: sql`NOW()`, archived_by: by, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async unarchive(subject, id) {
      const result = await db()
        .updateTable('actionable_items')
        .set({ archived_at: null, archived_by: null, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .where(visibleTo(subject))
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async decide(id, by, decision) {
      const result = await db()
        .updateTable('actionable_items')
        .set(
          decision === 'dismissed'
            ? {
                status: 'dismissed',
                decided_by: by,
                decided_at: sql`NOW()`,
                archived_at: sql`NOW()`,
                archived_by: by,
                updated_at: sql`NOW()`,
              }
            : {
                status: 'approved',
                decided_by: by,
                decided_at: sql`NOW()`,
                updated_at: sql`NOW()`,
              }
        )
        .where('id', '=', id)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async create(card) {
      await db().insertInto('actionable_items').values(newItemValues(card)).execute();
    },
    async updateOwnCreated(subject, id, patch) {
      const result = await db()
        .updateTable('actionable_items')
        .set({ ...itemPatchValues(patch), updated_at: sql`NOW()` })
        .where('id', '=', id)
        .where('owner_subject', '=', subject)
        .where('created_by', 'is not', null)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async dismissOwn(subject, id) {
      const result = await db()
        .updateTable('actionable_items')
        .set({
          status: 'dismissed',
          decided_by: subject,
          decided_at: sql`NOW()`,
          archived_at: sql`NOW()`,
          archived_by: subject,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .where('owner_subject', '=', subject)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async archiveOwnDecided(subject, id) {
      const result = await db()
        .updateTable('actionable_items')
        .set({ archived_at: sql`NOW()`, archived_by: subject, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .where('owner_subject', '=', subject)
        .where('status', '!=', 'suggested')
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async recordOutcome(id, status, result) {
      await db()
        .updateTable('actionable_items')
        .set({ status, result: JSON.stringify(result), updated_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
  };
}
