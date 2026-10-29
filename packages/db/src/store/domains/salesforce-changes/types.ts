/**
 * One Salesforce admin change request (migration 161), as stored. The JSON
 * columns come back as parsed JSON, unread: apps/web/lib/salesforce-admin/
 * change-requests.ts gives them their shapes (and reads an unknown status
 * as failed).
 */
export interface SalesforceChangeRecord {
  id: string;
  subject: string;
  agentId: string | null;
  connectorKey: string;
  orgId: string;
  instanceUrl: string;
  kind: string;
  title: string;
  reason: string | null;
  payload: unknown;
  validation: unknown;
  status: string;
  results: unknown;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  appliedBy: string | null;
  appliedAt: Date | null;
  cancelledAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  step: string | null;
  resolution: string | null;
}

/** A row the job sweep should look at. */
export interface RunnableChange {
  id: string;
  status: 'queued' | 'applying';
}

/**
 * The change requests' lifecycle. "Now" is the store's clock (Postgres's
 * NOW(), the process's in memory): a pending request past `expiresAt` is
 * never claimed, queued or counted. Every conditional write answers whether
 * it changed a row, which is how two racing clicks or sweeps tell who won.
 * Ids are the caller's to validate (a malformed one is refused, 22P02).
 */
export interface SalesforceChangeStore {
  /** File one, pending, expiring `ttlHours` from now. */
  create(input: {
    subject: string;
    agentId: string | null;
    connectorKey: string;
    orgId: string;
    instanceUrl: string;
    kind: string;
    title: string;
    reason: string | null;
    payload: unknown;
    ttlHours: number;
  }): Promise<SalesforceChangeRecord>;
  /** Store what the check-only deploy said. */
  setValidation(id: string, validation: unknown): Promise<void>;
  /** One by id; with `subject`, only when it is theirs. */
  get(id: string, options?: { subject?: string }): Promise<SalesforceChangeRecord | null>;
  /**
   * Newest first (ties by id), at most `limit`. `subject` narrows to one
   * person's, `connectorKey` to one org's, `pendingOnly` to pending and
   * unexpired.
   */
  list(options: {
    limit: number;
    subject?: string;
    pendingOnly?: boolean;
    connectorKey?: string;
  }): Promise<SalesforceChangeRecord[]>;
  /** Pending, unexpired requests per connector (one person's with `subject`), by connector key. */
  countPendingByConnector(options?: {
    subject?: string;
  }): Promise<{ connectorKey: string; count: number }[]>;
  /** The owner takes a pending, unexpired request for applying. */
  claim(subject: string, id: string): Promise<boolean>;
  /** Note the started deploy on an 'applying' request. */
  recordDeployStarted(id: string, results: unknown): Promise<void>;
  /** End an 'applying' request: its outcome, who applied it, the step cleared. */
  finish(
    id: string,
    outcome: { status: 'applied' | 'partial' | 'failed'; results: unknown; appliedBy: string }
  ): Promise<boolean>;
  /**
   * Cancel a pending request (expired or not); with `subject`, only theirs.
   * `resolution`, when given, is stored for the requester to read.
   */
  cancel(id: string, options: { subject?: string; resolution?: string }): Promise<boolean>;
  /** Approve a pending, unexpired request whose kind is not `exceptKind`: queue it. */
  queue(
    id: string,
    options: { approvedBy: string; step: string; exceptKind: string }
  ): Promise<boolean>;
  /** The job takes a queued request. */
  startQueued(id: string, step: string): Promise<boolean>;
  /** Take over an 'applying' request untouched for longer than `staleMs`; touches it. */
  reclaimStale(id: string, staleMs: number): Promise<boolean>;
  /** Say what a queued or applying request's job is doing (its heartbeat). */
  setStep(id: string, step: string): Promise<boolean>;
  /** Queued ones, and 'applying' ones untouched for longer than `staleMs`: least recently touched first (ties by id). */
  listRunnable(staleMs: number, limit: number): Promise<RunnableChange[]>;
  /** Close a pending request of `kind` as cancelled, with `resolution`. */
  closeAsProposed(id: string, options: { kind: string; resolution: string }): Promise<boolean>;
}
