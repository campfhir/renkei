import { orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { actionableItemFromRow } from './record';
import type { ActionableItemStore } from './types';

export function memoryActionableItems(tables: MemoryTables): ActionableItemStore {
  const idOf = (id: string) => tables.param('actionable_items', 'id', id);
  const visible = (subject: string) => (r: Row<'actionable_items'>) =>
    r.owner_subject === null || r.owner_subject === subject;
  const withAgent = (row: Row<'actionable_items'>) => {
    const agentId = row.created_by_agent_id;
    const agent = agentId ? tables.first('agents', (a) => a.id === agentId) : undefined;
    return actionableItemFromRow(row, agent?.name ?? null);
  };

  return {
    async listVisible(subject, { limit, offset = 0, includeArchived }) {
      const isVisible = visible(subject);
      const rows = tables.select(
        'actionable_items',
        (r) => isVisible(r) && (includeArchived || r.archived_at === null)
      );
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]), limit, offset).map(
        withAgent
      );
    },
    async findVisible(subject, id) {
      const key = idOf(id);
      const isVisible = visible(subject);
      const row = tables.first('actionable_items', (r) => r.id === key && isVisible(r));
      return row ? withAgent(row) : null;
    },
    async archive(id, by) {
      const key = idOf(id);
      const now = new Date();
      tables.update('actionable_items', (r) => r.id === key, {
        archived_at: now,
        archived_by: by,
        updated_at: now,
      });
    },
    async unarchive(subject, id) {
      const key = idOf(id);
      const isVisible = visible(subject);
      return tables.update('actionable_items', (r) => r.id === key && isVisible(r), {
        archived_at: null,
        archived_by: null,
        updated_at: new Date(),
      }).length;
    },
    async decide(id, by, decision) {
      const key = idOf(id);
      const now = new Date();
      return tables.update(
        'actionable_items',
        (r) => r.id === key && r.status === 'suggested',
        decision === 'dismissed'
          ? {
              status: 'dismissed',
              decided_by: by,
              decided_at: now,
              archived_at: now,
              archived_by: by,
              updated_at: now,
            }
          : { status: 'approved', decided_by: by, decided_at: now, updated_at: now }
      ).length;
    },
    async recordOutcome(id, status, result) {
      const key = idOf(id);
      tables.update('actionable_items', (r) => r.id === key, {
        status,
        result: JSON.stringify(result),
        updated_at: new Date(),
      });
    },
  };
}
