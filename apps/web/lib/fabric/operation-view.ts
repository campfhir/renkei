/**
 * A Fabric operation as the browser receives it: plain JSON, dates as ISO
 * strings, only the owner's own row. Pure, so the operation page's model
 * (app/(app)/fabric/operations/[operationId]/operation-view.model.ts) and
 * the routes share one shape.
 */

import type { FabricOperationRecord } from '@renkei/db';
import { isRecord } from '@renkei/guards';

export interface FabricOperationView {
  id: string;
  kind: 'notebook-definition' | 'pipeline-definition';
  workspaceId: string;
  workspaceName: string;
  itemId: string;
  itemName: string;
  format: string | null;
  status: 'running' | 'succeeded' | 'failed';
  percentComplete: number | null;
  error: string | null;
  parts: { path: string; text: string | null }[];
  createdAt: string;
  finishedAt: string | null;
  nextPollAt: string | null;
}

export function operationView(record: FabricOperationRecord): FabricOperationView {
  return {
    id: record.id,
    kind: record.kind,
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    itemId: record.itemId,
    itemName: record.itemName,
    format: record.format,
    status: record.status,
    percentComplete: record.percentComplete,
    error: record.error,
    parts: (record.result?.parts ?? []).map((part) => ({
      path: part.path,
      text: part.text ?? null,
    })),
    createdAt: record.createdAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
    nextPollAt: record.nextPollAt?.toISOString() ?? null,
  };
}

const KINDS = ['notebook-definition', 'pipeline-definition'] as const;
const STATUSES = ['running', 'succeeded', 'failed'] as const;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * An operation as the browser receives it from the routes, read field by
 * field; null when it is not one (a proxy's error page, a truncated event).
 */
export function readOperationView(value: unknown): FabricOperationView | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const kind = KINDS.find((k) => k === value.kind);
  const status = STATUSES.find((s) => s === value.status);
  if (!kind || !status) return null;
  return {
    id: value.id,
    kind,
    workspaceId: textOrNull(value.workspaceId) ?? '',
    workspaceName: textOrNull(value.workspaceName) ?? '',
    itemId: textOrNull(value.itemId) ?? '',
    itemName: textOrNull(value.itemName) ?? '',
    format: textOrNull(value.format),
    status,
    percentComplete: typeof value.percentComplete === 'number' ? value.percentComplete : null,
    error: textOrNull(value.error),
    parts: (Array.isArray(value.parts) ? value.parts : [])
      .filter(isRecord)
      .filter((part) => typeof part.path === 'string')
      .map((part) => ({ path: String(part.path), text: textOrNull(part.text) })),
    createdAt: textOrNull(value.createdAt) ?? '',
    finishedAt: textOrNull(value.finishedAt),
    nextPollAt: textOrNull(value.nextPollAt),
  };
}
