/**
 * The data store: the seam between the app and where its rows live.
 *
 * Callers that go through `getDataStore()` ask for domain records — a
 * session, a person's preference, a page of notifications — and never see
 * SQL. Two implementations stand behind it:
 *
 *   - postgres (./postgres.ts): the production store, Kysely against the
 *     one shared database;
 *   - memory (./memory.ts): plain JavaScript maps in the web process, for
 *     the UI suite that checks layout and navigation without a database
 *     (apps/web/playwright.memory.config.ts).
 *
 * Both are held to the same contract by ./contract.ts, which runs against
 * each (memory always, Postgres when DATABASE_URL is set) — so a page that
 * renders correctly on the memory store renders the same data on the real
 * one.
 *
 * The interface is deliberately domain-shaped, not table-shaped: it says
 * what a caller needs ("the unread count for this person"), so the memory
 * store can answer it without a query engine. Business rules — the idle
 * timeout, preference defaults, a tour's reducer — stay with the callers;
 * a store only keeps and returns what it is given.
 *
 * Every method rejects on a storage failure (a dropped connection, a
 * constraint), as Kysely does; callers wrap them the way they wrapped the
 * queries these replace.
 *
 * Not every table is behind this yet. Code that still calls
 * `getDatabase()` directly gets an error on the memory store (see
 * client.ts) rather than silently reaching a real database, and fails the
 * way it already fails when the database is down. Moving an area behind
 * the seam is: a repository here, both implementations, contract cases,
 * then the call sites.
 */

/** Which implementation answered. */
export type DataStoreKind = 'postgres' | 'memory';

/** A browser session row: an opaque id naming a subject and its roles. */
export interface SessionRecord {
  id: string;
  subject: string;
  roles: string[];
  expiresAt: Date;
  lastUsedAt: Date;
}

export interface SessionStore {
  create(session: { id: string; subject: string; roles: string[]; expiresAt: Date }): Promise<void>;
  /** Null when no such session exists — expiry is the caller's rule, not the store's. */
  find(id: string): Promise<SessionRecord | null>;
  /** Move `lastUsedAt` forward; unknown ids are ignored. */
  touch(id: string, at: Date): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Who a subject is, as recorded at their latest sign-in. */
export interface IdentityRecord {
  subject: string;
  email: string;
  displayName: string | null;
  idpGroups: string[];
}

export interface IdentityStore {
  get(subject: string): Promise<IdentityRecord | null>;
  /** Insert, or replace email, name and groups of an existing subject. */
  upsert(identity: IdentityRecord): Promise<void>;
  /** Empty a subject's groups; a subject with no row is left alone. */
  clearGroups(subject: string): Promise<void>;
  /** Everyone, by display name then email, ascending; a missing name sorts last. */
  list(): Promise<IdentityRecord[]>;
}

/**
 * Per-person settings: one JSON value per (subject, key). The value comes
 * back as it was stored (an object stays an object), and its shape is the
 * caller's to check — @renkei/user-prefs parses every read.
 */
export interface UserPreferenceStore {
  /** Undefined when the person has never saved this key. */
  get(subject: string, key: string): Promise<unknown>;
  set(subject: string, key: string, value: unknown): Promise<void>;
}

/** Org-wide settings: one JSON value per key (@renkei/settings parses them). */
export interface SettingsStore {
  /** Every stored key and its value. */
  all(): Promise<Map<string, unknown>>;
  /** Undefined when the key has never been set. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** One person's record of one coach-mark tour. Timestamps are ISO strings. */
export interface CoachMarkProgressRecord {
  tourId: string;
  version: number;
  status: string;
  stepReached: number;
  stepsTotal: number;
  viewCount: number;
  completedCount: number;
  dismissedCount: number;
  firstViewedAt: string;
  lastViewedAt: string;
  completedAt: string | null;
  dismissedAt: string | null;
  reportedAt: string;
}

export interface CoachMarkStore {
  /** One person's rows, by tour id. */
  list(subject: string): Promise<CoachMarkProgressRecord[]>;
  /**
   * Read, decide, write — atomically per (subject, tour): two applies for
   * the same row never both read the row before the other wrote it. `next`
   * is a pure function of the existing row (null for a first report) and
   * its answer is what gets stored and returned. Its `tourId` must be the
   * one asked for.
   */
  apply(
    subject: string,
    tourId: string,
    next: (existing: CoachMarkProgressRecord | null) => CoachMarkProgressRecord
  ): Promise<CoachMarkProgressRecord>;
  /** Every row in the deployment, most recently changed first. */
  listAll(): Promise<{ subject: string; progress: CoachMarkProgressRecord }[]>;
}

/** One entry in a person's notification feed. */
export interface NotificationRecord {
  id: string;
  subject: string;
  kind: string;
  category: string | null;
  connector: string | null;
  tool: string | null;
  entity: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  meta: unknown;
  readAt: Date | null;
  createdAt: Date;
}

/** Which of a person's notifications a bulk change reaches. */
export type NotificationTarget = { ids: string[] } | { all: true };

export interface NotificationStore {
  /**
   * One person's feed, newest first. `since` and `before` are exclusive
   * bounds on `createdAt`.
   */
  list(
    subject: string,
    options: { limit: number; since?: Date; before?: Date; unreadOnly?: boolean }
  ): Promise<NotificationRecord[]>;
  countUnread(subject: string): Promise<number>;
  /**
   * Mark the target read (or, `unread: true`, unread again), touching only
   * rows not already in that state; returns how many changed. Ids that are
   * not this person's change nothing.
   */
  mark(subject: string, target: NotificationTarget, options: { unread: boolean }): Promise<number>;
  /** Delete the target; returns how many went. Ids that are not this person's delete nothing. */
  delete(subject: string, target: NotificationTarget): Promise<number>;
  /**
   * Add one. `createdAt` defaults to now, `readAt` to unread. The writers
   * that produce notifications (agents, batch jobs, chat events) still use
   * the table directly; this is what fixtures and the contract use.
   */
  insert(
    notification: Omit<NotificationRecord, 'createdAt' | 'readAt'> & {
      createdAt?: Date;
      readAt?: Date | null;
    }
  ): Promise<void>;
}

export interface DataStore {
  readonly kind: DataStoreKind;
  readonly sessions: SessionStore;
  readonly identities: IdentityStore;
  readonly userPreferences: UserPreferenceStore;
  readonly settings: SettingsStore;
  readonly coachMarks: CoachMarkStore;
  readonly notifications: NotificationStore;
}
