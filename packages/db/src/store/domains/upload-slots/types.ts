/**
 * Upload slots (upload_slots): the out-of-band byte path a
 * *_request_*_upload tool mints (apps/web/lib/mcp-tools/upload-slots.ts)
 * and /api/upload/[slotId] fills. Only the sha256 of a slot's bearer is
 * kept, and a record never carries it back.
 */

export interface UploadSlotRecord {
  id: string;
  subject: string;
  accountId: string;
  kind: string;
  /** The destination as stored (jsonb). */
  destination: unknown;
  filename: string;
  contentType: string | null;
  maxBytes: number;
  /** `pending`, `completed` or `failed`. */
  status: string;
  result: string | null;
  expiresAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

export interface NewUploadSlotRecord {
  id: string;
  tokenHash: string;
  subject: string;
  accountId: string;
  kind: string;
  destination: Record<string, unknown>;
  filename: string;
  contentType: string | null;
  maxBytes: number;
  expiresAt: Date;
}

/** How a claim proves it may fill the slot: the bearer's hash, or the owner's subject. */
export type UploadSlotClaim = { tokenHash: string } | { subject: string };

export interface UploadSlotStore {
  /** Rejects on a duplicate id or bearer hash (23505). */
  create(input: NewUploadSlotRecord): Promise<void>;
  get(slotId: string): Promise<UploadSlotRecord | null>;
  /**
   * Claims a pending, unexpired slot — by its bearer's hash, or by its
   * owner — flipping it to `completed` (the busy marker) in one
   * statement; null when it is not there, not pending, expired, or the
   * proof does not match.
   */
  claim(slotId: string, proof: UploadSlotClaim): Promise<UploadSlotRecord | null>;
  /** Records the outcome: `completed` or `failed`, with its detail, finished now. */
  finish(slotId: string, outcome: { ok: boolean; detail: string }): Promise<void>;
  /** Replaces the destination (OnBase's staging reference rides it). */
  setDestination(slotId: string, destination: Record<string, unknown>): Promise<void>;
  /** Mark every pending slot past its expiry `expired` (by the database's clock); returns how many. */
  expireStale(): Promise<number>;
  /**
   * Delete up to `limit` terminal slots (completed, failed, expired)
   * created more than `days` days ago, oldest first (ties by id); returns
   * how many went.
   */
  pruneSettled(days: number, limit: number): Promise<number>;
}
