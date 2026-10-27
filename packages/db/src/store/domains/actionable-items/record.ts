import type { Selectable } from 'kysely';
import type { ActionableItems } from '../../../db.types';
import type { ActionableItemRecord } from './types';

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
