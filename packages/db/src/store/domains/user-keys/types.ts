/**
 * The rows behind a person's keys (docs/delegate-key-design.md), read as
 * stored: their key row (public key, wrapped keys), the delegations their
 * browser sealed to delegate instances, and the instances alive to seal
 * to. Nothing here opens anything — @renkei/user-keys does, with the
 * delegate's own keypair.
 */

/** A person's `user_encryption_keys` row; the wrapped keys stay wrapped. */
export interface UserKeyRowRecord {
  version: number;
  mode: string;
  publicKey: string | null;
  wrappedPrivateKey: string | null;
  wrappedAutomationKey: string | null;
  enrolledAt: Date | null;
  verifier: string | null;
}

/** One delegation sealed to one instance, as stored. */
export interface UserKeyDelegationRecord {
  scope: string;
  sessionId: string | null;
  sealedKey: string;
}

/** One live delegation, without its sealed key — what the status view counts. */
export interface UserKeyDelegationSummaryRecord {
  instanceId: string;
  scope: string;
  sessionId: string | null;
  expiresAt: Date;
}

export interface UserKeyInstanceRecord {
  id: string;
  /** Raw X25519 public key, base64. */
  publicKey: string;
}

export interface UserKeyStore {
  findKeyRow(subject: string): Promise<UserKeyRowRecord | null>;
  /**
   * The person's delegations to this instance that expire after `now`,
   * newest first (ties by id, descending).
   */
  liveDelegations(
    subject: string,
    instanceId: string,
    now: Date
  ): Promise<UserKeyDelegationRecord[]>;
  /** Every delegation of the person expiring after `now`, oldest first (ties by id). */
  delegationsOf(subject: string, now: Date): Promise<UserKeyDelegationSummaryRecord[]>;
  /** Instances whose heartbeat is after `since`, by start time (ties by id). */
  liveInstances(since: Date): Promise<UserKeyInstanceRecord[]>;
}
