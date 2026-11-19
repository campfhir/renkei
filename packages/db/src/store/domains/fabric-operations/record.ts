import type { Selectable } from 'kysely';
import type { FabricOperations } from '../../../db.types';
import { isRecord } from '@renkei/guards';
import type {
  FabricDefinitionPart,
  FabricOperationKind,
  FabricOperationRecord,
  FabricOperationResult,
  FabricOperationStatus,
} from './types';

const KINDS: readonly FabricOperationKind[] = ['notebook-definition', 'pipeline-definition'];
const STATUSES: readonly FabricOperationStatus[] = ['running', 'succeeded', 'failed'];

function kindOf(value: string): FabricOperationKind {
  return KINDS.find((kind) => kind === value) ?? 'notebook-definition';
}

function statusOf(value: string): FabricOperationStatus {
  return STATUSES.find((status) => status === value) ?? 'failed';
}

function partOf(value: unknown): FabricDefinitionPart | null {
  if (!isRecord(value) || typeof value.path !== 'string') return null;
  return {
    path: value.path,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.base64 === 'string' ? { base64: value.base64 } : {}),
  };
}

/** The stored result back as a typed value; anything malformed reads as none. */
export function resultOf(value: unknown): FabricOperationResult | null {
  if (!isRecord(value) || !Array.isArray(value.parts)) return null;
  return {
    format: typeof value.format === 'string' ? value.format : null,
    parts: value.parts.map(partOf).filter((part): part is FabricDefinitionPart => part !== null),
  };
}

const date = (value: Date | string | null): Date | null => (value ? new Date(value) : null);

export function fabricOperationFromRow(row: Selectable<FabricOperations>): FabricOperationRecord {
  return {
    id: row.id,
    subject: row.subject,
    kind: kindOf(row.kind),
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    itemId: row.item_id,
    itemName: row.item_name,
    format: row.format,
    status: statusOf(row.status),
    operationId: row.operation_id,
    percentComplete: row.percent_complete,
    result: resultOf(row.result),
    error: row.error,
    nextPollAt: date(row.next_poll_at),
    watchedAt: date(row.watched_at),
    notifiedAt: date(row.notified_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    finishedAt: date(row.finished_at),
  };
}
