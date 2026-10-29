import type { RunnableChange } from '../salesforce-changes/types';

/**
 * One Jira admin change request (migration 120), as stored. The JSON
 * columns come back as parsed JSON, unread: apps/web/lib/jira-admin/
 * change-requests.ts gives them their shapes.
 */
export interface JiraChangeRecord {
  id: string;
  subject: string;
  agentId: string | null;
  cloudId: string;
  siteUrl: string | null;
  kind: string;
  title: string;
  reason: string | null;
  payload: unknown;
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

/**
 * The change requests' lifecycle. "Now" is the store's clock (Postgres's
 * NOW(), the process's in memory): a pending request past `expiresAt` is
 * never claimed, queued or counted. Every conditional write answers whether
 * it changed a row, which is how two racing clicks or sweeps tell who won.
 * Ids are the caller's to validate (a malformed one is refused, 22P02).
 */
export interface JiraChangeStore {
  /** File one, pending, expiring `ttlHours` from now. */
  create(input: {
    subject: string;
    agentId: string | null;
    cloudId: string;
    siteUrl: string | null;
    kind: string;
    title: string;
    reason: string | null;
    payload: unknown;
    ttlHours: number;
  }): Promise<JiraChangeRecord>;
  /** One by id; with `subject`, only when it is theirs. */
  get(id: string, options?: { subject?: string }): Promise<JiraChangeRecord | null>;
  /**
   * Newest first (ties by id), at most `limit`. `subject` narrows to one
   * person's, `pendingOnly` to pending and unexpired.
   */
  list(options: {
    limit: number;
    subject?: string;
    pendingOnly?: boolean;
  }): Promise<JiraChangeRecord[]>;
  /** How many are pending and unexpired (one person's with `subject`). */
  countPending(options?: { subject?: string }): Promise<number>;
  /** The owner takes a pending, unexpired request for applying. */
  claim(subject: string, id: string): Promise<boolean>;
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
