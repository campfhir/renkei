/** An upload slot without its bearer digest. `destination` is parsed JSON, unread. */
export interface UploadSlotRecord {
  id: string;
  subject: string;
  accountId: string;
  kind: string;
  destination: unknown;
  filename: string;
  contentType: string | null;
  maxBytes: number;
  status: string;
  result: string | null;
  expiresAt: Date;
  completedAt: Date | null;
}

export interface NewUploadSlot {
  id: string;
  /** sha256 hex of the slot's bearer — the bearer itself is never stored. */
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

/**
 * Upload slots (`upload_slots`): the out-of-band byte path a
 * *_request_*_upload tool mints. Slot ids arrive from tool arguments; a
 * malformed one is refused (22P02), as Postgres does.
 */
export interface UploadSlotStore {
  create(slot: NewUploadSlot): Promise<void>;
  /** One slot by id, whoever owns it, or null — the caller checks ownership. */
  get(id: string): Promise<UploadSlotRecord | null>;
  /**
   * Claim the subject's own still-pending slot that has not expired at
   * `now`: it becomes `completed` at `now` and is returned; anything else
   * (someone else's, expired, already used) is null.
   */
  claimPendingByOwner(id: string, subject: string, now: Date): Promise<UploadSlotRecord | null>;
}
