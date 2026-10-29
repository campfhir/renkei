/** One "send my key to this device" ask (docs/delegate-key-design.md, "Another device"). */
export interface DeviceKeyRequestRecord {
  id: string;
  subject: string;
  publicKey: string;
  code: string;
  sealedKey: string | null;
  askingSessionId: string | null;
  userAgent: string | null;
  attempts: number;
  consumedAt: Date | null;
  deniedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * The device-key relay. Every read and write is keyed by the person's
 * subject or by a request id the route already resolved for that subject;
 * ids arrive from URLs and a malformed one is refused (22P02).
 */
export interface DeviceKeyRequestStore {
  /**
   * The asks still open at `now` — unsealed, unconsumed, undenied, not
   * expired — oldest first (ties by id).
   */
  listPending(subject: string, now: Date): Promise<DeviceKeyRequestRecord[]>;
  /** Drop this person's asks made before `before`; returns how many went. */
  purgeBefore(subject: string, before: Date): Promise<number>;
  /** How many asks this person made at or after `since`, whatever became of them. */
  countSince(subject: string, since: Date): Promise<number>;
  create(input: {
    subject: string;
    publicKey: string;
    code: string;
    askingSessionId: string;
    userAgent: string | null;
    expiresAt: Date;
  }): Promise<DeviceKeyRequestRecord>;
  /** One of this person's asks. */
  get(subject: string, id: string): Promise<DeviceKeyRequestRecord | null>;
  /** Set the wrong-code count, denying the ask (at `deniedAt`) when given. */
  recordMiss(id: string, attempts: number, deniedAt: Date | null): Promise<void>;
  /** Hand the sealed key over: clear it and mark the ask consumed at `at`. */
  consume(id: string, at: Date): Promise<void>;
  /**
   * Answer an ask with a sealed key, if it is still unsealed, undenied and
   * unexpired at `now`; returns how many rows changed.
   */
  seal(id: string, sealedKey: string, approvedBySessionId: string, now: Date): Promise<number>;
  /** Deny one of this person's asks not denied yet; returns how many rows changed. */
  deny(subject: string, id: string, at: Date): Promise<number>;
}
