/**
 * Fabric operations (fabric_operations): a Microsoft Fabric request that
 * Fabric answers later — getting a notebook's or a data pipeline's
 * definition, which Fabric may hand back as a long-running operation to
 * poll. Owned by the person who asked; `nextPollAt` is when Fabric said
 * to look again and, once a poller claims the row, its lease.
 */

export type FabricOperationKind = 'notebook-definition' | 'pipeline-definition';
export type FabricOperationStatus = 'running' | 'succeeded' | 'failed';

/** One part of a definition, decoded: `text` for UTF-8 content, else `base64`. */
export interface FabricDefinitionPart {
  path: string;
  text?: string;
  base64?: string;
}

export interface FabricOperationResult {
  format: string | null;
  parts: FabricDefinitionPart[];
}

export interface FabricOperationRecord {
  id: string;
  subject: string;
  kind: FabricOperationKind;
  workspaceId: string;
  workspaceName: string;
  itemId: string;
  itemName: string;
  format: string | null;
  status: FabricOperationStatus;
  /** Fabric's own operation id (x-ms-operation-id); null when it answered at once. */
  operationId: string | null;
  percentComplete: number | null;
  result: FabricOperationResult | null;
  error: string | null;
  nextPollAt: Date | null;
  watchedAt: Date | null;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export type FabricOperationInsert = Pick<
  FabricOperationRecord,
  | 'id'
  | 'subject'
  | 'kind'
  | 'workspaceId'
  | 'workspaceName'
  | 'itemId'
  | 'itemName'
  | 'format'
  | 'status'
  | 'operationId'
  | 'percentComplete'
  | 'result'
  | 'error'
  | 'nextPollAt'
  | 'finishedAt'
> & { createdAt: Date };

export interface FabricOperationStore {
  /** Add one; reads back as stored. */
  insert(operation: FabricOperationInsert): Promise<FabricOperationRecord>;
  /** One of this person's operations; null when it is not theirs or does not exist. */
  find(subject: string, id: string): Promise<FabricOperationRecord | null>;
  /** This person's operations, newest first (ties by id, descending). */
  list(subject: string, options: { limit: number }): Promise<FabricOperationRecord[]>;
  /**
   * Take the lease on one running operation that is due (`nextPollAt` null
   * or not after `now`): its `nextPollAt` becomes `leaseUntil`. Null when
   * it is not running, not due, or another poller holds it.
   */
  claim(id: string, now: Date, leaseUntil: Date): Promise<FabricOperationRecord | null>;
  /**
   * Take the lease on up to `limit` running operations that are due and
   * that no browser has watched since `unwatchedSince` (a watched one is
   * polled by its own stream), oldest due first (ties by id); returned by id.
   */
  claimDue(options: {
    now: Date;
    leaseUntil: Date;
    unwatchedSince: Date;
    limit: number;
  }): Promise<FabricOperationRecord[]>;
  /** Record progress on a running operation; null when it is no longer running. */
  progress(
    id: string,
    patch: { percentComplete: number | null; nextPollAt: Date; operationId?: string | null },
    at: Date
  ): Promise<FabricOperationRecord | null>;
  /**
   * End a running operation. Only the call that makes the transition gets
   * the row back; a second finisher (or a finished row) gets null.
   */
  finish(
    id: string,
    outcome: {
      status: 'succeeded' | 'failed';
      result: FabricOperationResult | null;
      error: string | null;
    },
    at: Date
  ): Promise<FabricOperationRecord | null>;
  /** Note that this person's browser is watching the operation now. */
  markWatched(subject: string, id: string, at: Date): Promise<void>;
  /** Note the owner was told it ended; true only for the first call. */
  markNotified(id: string, at: Date): Promise<boolean>;
  /** Delete operations that finished before `before`; how many went. */
  deleteFinishedBefore(before: Date): Promise<number>;
}
