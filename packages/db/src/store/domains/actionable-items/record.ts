import type { Selectable } from 'kysely';
import type { ActionableItems } from '../../../db.types';
import type { ActionableItemRecord, NewActionableItem } from './types';

export function newItemValues(card: NewActionableItem) {
  return {
    id: card.id,
    source: card.source,
    ...(card.kind !== undefined ? { kind: card.kind } : {}),
    title: card.title,
    summary: card.summary,
    evidence: JSON.stringify(card.evidence),
    suggested_action:
      card.suggestedAction === null || card.suggestedAction === undefined
        ? null
        : JSON.stringify(card.suggestedAction),
    owner_subject: card.ownerSubject,
    created_by: card.createdBy,
    created_by_agent_id: card.createdByAgentId,
  };
}

export function itemPatchValues(patch: { title?: string; summary?: string; evidence?: unknown }) {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.evidence !== undefined ? { evidence: JSON.stringify(patch.evidence) } : {}),
  };
}

export function actionableItemFromRow(
  row: Selectable<ActionableItems>,
  agentName: string | null
): ActionableItemRecord {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: row.summary,
    evidence: row.evidence ?? null,
    result: row.result ?? null,
    suggestedAction: row.suggested_action ?? null,
    runId: row.run_id,
    agentId: row.created_by_agent_id,
    agentName,
    ownerSubject: row.owner_subject,
    createdAt: new Date(row.created_at),
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
  };
}
