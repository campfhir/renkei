import { orderBy, page } from '../../memory/order';
import { parseJson, toJson, type MemoryTables, type Row } from '../../memory/tables';
import { actionableItemFromRow, itemPatchValues, newItemValues } from './record';
import type { ActionableItemStore } from './types';

type Item = Row<'actionable_items'>;

/** An actionable_items row's defaults, for every domain that raises a card. */
export function itemDefaults(now: Date): Omit<Item, 'id' | 'source' | 'title' | 'summary'> {
  return {
    kind: 'action',
    status: 'suggested',
    evidence: [],
    suggested_action: null,
    result: null,
    owner_subject: null,
    created_by: null,
    created_by_agent_id: null,
    run_id: null,
    step_id: null,
    attempt: null,
    iteration: null,
    decided_at: null,
    decided_by: null,
    archived_at: null,
    archived_by: null,
    created_at: now,
    updated_at: now,
  };
}

export function memoryActionableItems(tables: MemoryTables): ActionableItemStore {
  const visible = (subject: string) => (r: Row<'actionable_items'>) =>
    r.owner_subject === null || r.owner_subject === subject;
  const withAgent = (row: Row<'actionable_items'>) => {
    const agentId = row.created_by_agent_id;
    const agent = agentId ? tables.first('agents', (a) => a.id === agentId) : undefined;
    return actionableItemFromRow(row, agent?.name ?? null);
  };

  return {
    async listVisible(subject, { limit, offset = 0, includeArchived, status }) {
      const isVisible = visible(subject);
      const rows = tables.select(
        'actionable_items',
        (r) =>
          isVisible(r) &&
          (includeArchived || r.archived_at === null) &&
          (status === undefined || r.status === status)
      );
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]), limit, offset).map(
        withAgent
      );
    },
    async findVisible(subject, id) {
      const key = id;
      const isVisible = visible(subject);
      const row = tables.first('actionable_items', (r) => r.id === key && isVisible(r));
      return row ? withAgent(row) : null;
    },
    async archive(id, by) {
      const key = id;
      const now = new Date();
      tables.update('actionable_items', (r) => r.id === key, {
        archived_at: now,
        archived_by: by,
        updated_at: now,
      });
    },
    async unarchive(subject, id) {
      const key = id;
      const isVisible = visible(subject);
      return tables.update('actionable_items', (r) => r.id === key && isVisible(r), {
        archived_at: null,
        archived_by: null,
        updated_at: new Date(),
      }).length;
    },
    async decide(id, by, decision) {
      const key = id;
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
    async create(card) {
      const values = newItemValues(card);
      tables.insert('actionable_items', {
        ...itemDefaults(new Date()),
        ...values,
        evidence: parseJson(values.evidence),
        suggested_action: parseJson(values.suggested_action),
      });
    },
    async updateOwnCreated(subject, id, patch) {
      const key = id;
      return tables.update(
        'actionable_items',
        (r) =>
          r.id === key &&
          r.owner_subject === subject &&
          r.created_by !== null &&
          r.status === 'suggested',
        {
          ...itemPatchValues(patch),
          ...(patch.evidence !== undefined ? { evidence: toJson(patch.evidence) } : {}),
          updated_at: new Date(),
        }
      ).length;
    },
    async dismissOwn(subject, id) {
      const key = id;
      const now = new Date();
      return tables.update(
        'actionable_items',
        (r) => r.id === key && r.owner_subject === subject && r.status === 'suggested',
        {
          status: 'dismissed',
          decided_by: subject,
          decided_at: now,
          archived_at: now,
          archived_by: subject,
          updated_at: now,
        }
      ).length;
    },
    async archiveOwnDecided(subject, id) {
      const key = id;
      const now = new Date();
      return tables.update(
        'actionable_items',
        (r) =>
          r.id === key &&
          r.owner_subject === subject &&
          r.status !== 'suggested' &&
          r.archived_at === null,
        { archived_at: now, archived_by: subject, updated_at: now }
      ).length;
    },
    async recordOutcome(id, status, result) {
      const key = id;
      tables.update('actionable_items', (r) => r.id === key, {
        status,
        result: toJson(result),
        updated_at: new Date(),
      });
    },
    async setRelatedEvidence(id, related, relatedElided) {
      const key = id;
      // jsonb_set over an object; the card's evidence is always one.
      return tables.update(
        'actionable_items',
        (r) => r.id === key && r.status === 'suggested',
        (r) => {
          const evidence =
            typeof r.evidence === 'object' && r.evidence !== null && !Array.isArray(r.evidence)
              ? r.evidence
              : {};
          return {
            evidence: toJson({
              ...evidence,
              related: related ?? null,
              relatedElided: relatedElided ?? null,
            }),
            updated_at: new Date(),
          };
        }
      ).length;
    },
  };
}
