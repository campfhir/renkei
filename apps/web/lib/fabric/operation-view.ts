/**
 * A Fabric operation as the browser receives it: plain JSON, dates as ISO
 * strings, only the owner's own row. Pure, so the operation page's model
 * (app/(app)/fabric/operations/[operationId]/operation-view.model.ts) and
 * the routes share one shape.
 */

import type { FabricOperationRecord } from '@renkei/db';

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
