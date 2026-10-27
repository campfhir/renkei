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

  // ── The delegate instances themselves ───────────────────────────────

  /** A new instance row with its public key; started and heartbeat now. */
  registerInstance(id: string, publicKey: string): Promise<void>;
  /** The instance's heartbeat, moved to `at`. */
  heartbeatInstance(id: string, at: Date): Promise<void>;
  /** Delete the instances whose heartbeat is before `before` (delegations cascade); how many. */
  deleteStaleInstances(before: Date): Promise<number>;
  /** Delete one instance (its delegations cascade); how many went. */
  deleteInstance(id: string): Promise<number>;

  // ── Delegations, enrollment, rotation, the shred ────────────────────

  /**
   * Write a browser's sealed delegations, in one transaction: this
   * session's session rows replace its earlier ones; when any automation
   * rows survive, they replace the person's earlier automation rows.
   * Entries for an instance that is not registered are dropped.
   */
  writeDelegations(subject: string, write: UserKeyDelegationWrite): Promise<void>;
  /** Delete the person's automation delegations; how many went. */
  revokeAutomation(subject: string): Promise<number>;
  /**
   * In one transaction: delete every user, automation and public wrapping
   * held by the person, then their key row (delegations cascade). True
   * when there was a key row.
   */
  shred(subject: string): Promise<boolean>;
  /** How many key rows there are of each mode, by mode. */
  countByMode(): Promise<{ mode: string; count: number }[]>;
  /**
   * The person's key row, created as a managed row with `salt` when they
   * have none: its salt, mode and version as stored.
   */
  ensureLegacyRow(
    subject: string,
    salt: string
  ): Promise<{ salt: string; mode: string; version: number }>;
  /**
   * A change of the person's keys, atomically: lock their key row, hand
   * it (null when there is none) to `plan` with a reader of everything
   * sealed for them (read and locked on demand), and — when the plan says
   * commit — write the re-sealed rows, the key row, and the delegations
   * in the same transaction. `plan` decides; it does no I/O of its own
   * beyond the reader it is given. A plan that does not commit writes
   * nothing. Returns the plan's answer.
   */
  changeKeys<A>(
    subject: string,
    plan: (
      current: UserKeyCurrentRecord | null,
      readSealed: () => Promise<UserKeySealedRows>
    ) => Promise<UserKeyChangePlan<A>>
  ): Promise<A>;
}

/** What a browser sealed for a sign-in, ready to store. */
export interface UserKeyDelegationWrite {
  /** The browser session the session rows live and die with. */
  sessionId: string;
  session: { instanceId: string; sealedKey: string }[];
  sessionExpiresAt: Date;
  automation: { instanceId: string; sealedKey: string }[];
  automationExpiresAt: Date;
}

/** A person's key row as a change of keys reads it (the legacy columns included). */
export interface UserKeyCurrentRecord {
  salt: string;
  mode: string;
  version: number;
  verifier: string | null;
  sealedKek: string | null;
  unlockedUntil: Date | null;
}

/** Tables holding values sealed directly under one person's own keys. */
export type UserKeySealedTable =
  | 'provider_grants'
  | 'mirth_instance_connections'
  | 'admanager_instance_connections'
  | 'file_share_connections'
  | 'chat_user_memories';

/** One row of a sealed table: its identity (the table's id columns, in order) and its sealed columns. */
export interface UserKeySealedValueRecord {
  table: UserKeySealedTable;
  id: string[];
  values: Record<string, string | null>;
}

/** Everything at rest under one person's own keys. */
export interface UserKeySealedRows {
  /** Their `user` and `automation` wrappings of resource keys, by key id then kind. */
  wrappings: { resourceKeyId: string; holderKind: string; wrappedKey: string }[];
  /** Their rows of every sealed table, table by table, by id. */
  values: UserKeySealedValueRecord[];
}

export type UserKeyRowChange =
  /** Enrollment: insert the held row, or turn the legacy row into it (salt kept, rotated_at = enrolledAt). */
  | {
      kind: 'enroll';
      salt: string;
      version: number;
      publicKey: string;
      wrappedPrivateKey: string;
      wrappedAutomationKey: string;
      enrolledAt: Date;
      verifier: string;
      rotatedAt: Date | null;
    }
  /** Rotation: the new version and wrappings on the existing row. */
  | {
      kind: 'rotate';
      version: number;
      wrappedPrivateKey: string;
      wrappedAutomationKey: string;
      rotatedAt: Date;
    };

export type UserKeyChangePlan<A> =
  | { commit: false; answer: A }
  | {
      commit: true;
      answer: A;
      /** Re-sealed wrappings (by key and kind) and values (by table and id); only the columns given change. */
      rewrite: {
        wrappings: {
          resourceKeyId: string;
          holderKind: string;
          wrappedKey: string;
          kekVersion: number;
        }[];
        values: { table: UserKeySealedTable; id: string[]; values: Record<string, string> }[];
      };
      keyRow: UserKeyRowChange;
      /** Delete every delegation of the person before writing the new ones (a rotation). */
      dropDelegations: boolean;
      delegations: UserKeyDelegationWrite;
    };
