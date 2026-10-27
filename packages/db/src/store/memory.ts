import type {
  CoachMarkProgressRecord,
  DataStore,
  IdentityRecord,
  NotificationRecord,
  NotificationTarget,
  SessionRecord,
} from './types';

/**
 * The data store in plain JavaScript: maps in this process, nothing on
 * disk, nothing shared with any other process. For the UI suite
 * (apps/web/playwright.memory.config.ts) and for unit tests that need a
 * store but not a database.
 *
 * It answers exactly what the Postgres store answers — ./contract.ts runs
 * the same cases against both — including the details a page can see: JSON
 * values come back as a JSON round trip would leave them, lists come back
 * in the same order, and every read hands out a copy, so a caller mutating
 * what it got cannot change what the next caller reads.
 */
export interface MemoryDataStore extends DataStore {
  readonly kind: 'memory';
  /** Add fixtures through the store's own writes. */
  seed(fixtures: MemorySeed): Promise<void>;
  /** Forget everything, or only what one subject owns. */
  reset(subject?: string): void;
}

/** What a fixture can put in the store; everything optional. */
export interface MemorySeed {
  sessions?: { id: string; subject: string; roles: string[]; expiresAt: Date | string }[];
  identities?: IdentityRecord[];
  userPreferences?: { subject: string; key: string; value: unknown }[];
  settings?: { key: string; value: unknown }[];
  notifications?: (Omit<NotificationRecord, 'createdAt' | 'readAt'> & {
    createdAt?: Date | string;
    readAt?: Date | string | null;
  })[];
}

/** What jsonb would hand back: Dates become strings, undefined fields go. */
function jsonRoundTrip(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function matches(target: NotificationTarget, id: string): boolean {
  return 'all' in target || target.ids.includes(id);
}

/** Postgres's ascending order: nulls last. */
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, 'en');
}

export function createMemoryDataStore(): MemoryDataStore {
  const sessions = new Map<string, SessionRecord>();
  const identities = new Map<string, IdentityRecord>();
  const userPreferences = new Map<string, { subject: string; value: unknown }>();
  const settings = new Map<string, unknown>();
  const coachMarks = new Map<
    string,
    { subject: string; record: CoachMarkProgressRecord; updatedAt: number }
  >();
  let notifications: NotificationRecord[] = [];
  // Strictly increasing, so "most recently changed" never ties within a
  // millisecond the way two Date.now() reads can.
  let clock = 0;
  const tick = () => (clock = Math.max(clock + 1, Date.now()));

  const prefKey = (subject: string, key: string) => JSON.stringify([subject, key]);
  const tourKey = (subject: string, tourId: string) => JSON.stringify([subject, tourId]);
  const copySession = (s: SessionRecord): SessionRecord => ({
    ...s,
    roles: [...s.roles],
    expiresAt: new Date(s.expiresAt),
    lastUsedAt: new Date(s.lastUsedAt),
  });
  const copyIdentity = (i: IdentityRecord): IdentityRecord => ({
    ...i,
    idpGroups: [...i.idpGroups],
  });
  const copyNotification = (n: NotificationRecord): NotificationRecord => ({
    ...n,
    meta: jsonRoundTrip(n.meta) ?? null,
    readAt: n.readAt ? new Date(n.readAt) : null,
    createdAt: new Date(n.createdAt),
  });

  const store: MemoryDataStore = {
    kind: 'memory',

    sessions: {
      async create({ id, subject, roles, expiresAt }) {
        if (sessions.has(id)) throw new Error(`duplicate session id ${id}`);
        const now = new Date();
        sessions.set(id, copySession({ id, subject, roles, expiresAt, lastUsedAt: now }));
      },
      async find(id) {
        const found = sessions.get(id);
        return found ? copySession(found) : null;
      },
      async touch(id, at) {
        const found = sessions.get(id);
        if (found) found.lastUsedAt = new Date(at);
      },
      async delete(id) {
        sessions.delete(id);
      },
    },

    identities: {
      async get(subject) {
        const found = identities.get(subject);
        return found ? copyIdentity(found) : null;
      },
      async upsert(identity) {
        identities.set(identity.subject, copyIdentity(identity));
      },
      async clearGroups(subject) {
        const found = identities.get(subject);
        if (found) found.idpGroups = [];
      },
      async list() {
        return [...identities.values()]
          .sort(
            (a, b) =>
              compareNullable(a.displayName, b.displayName) || compareNullable(a.email, b.email)
          )
          .map(copyIdentity);
      },
    },

    userPreferences: {
      async get(subject, key) {
        return jsonRoundTrip(userPreferences.get(prefKey(subject, key))?.value);
      },
      async set(subject, key, value) {
        userPreferences.set(prefKey(subject, key), { subject, value: jsonRoundTrip(value) });
      },
    },

    settings: {
      async all() {
        return new Map([...settings].map(([key, value]) => [key, jsonRoundTrip(value)]));
      },
      async get(key) {
        return jsonRoundTrip(settings.get(key));
      },
      async set(key, value) {
        settings.set(key, jsonRoundTrip(value));
      },
    },

    coachMarks: {
      async list(subject) {
        return [...coachMarks.values()]
          .filter((row) => row.subject === subject)
          .map((row) => ({ ...row.record }))
          .sort((a, b) => (a.tourId < b.tourId ? -1 : a.tourId > b.tourId ? 1 : 0));
      },
      // No lock needed: `next` is synchronous, so nothing else runs between
      // this read and this write.
      async apply(subject, tourId, next) {
        const key = tourKey(subject, tourId);
        const existing = coachMarks.get(key);
        const record = next(existing ? { ...existing.record } : null);
        // The Postgres row keeps the first view it was inserted with.
        const stored = existing
          ? { ...record, tourId, firstViewedAt: existing.record.firstViewedAt }
          : { ...record, tourId };
        coachMarks.set(key, { subject, record: stored, updatedAt: tick() });
        return { ...record };
      },
      async listAll() {
        return [...coachMarks.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((row) => ({ subject: row.subject, progress: { ...row.record } }));
      },
    },

    notifications: {
      async list(subject, { limit, since, before, unreadOnly }) {
        return notifications
          .filter(
            (n) =>
              n.subject === subject &&
              (!since || n.createdAt.getTime() > since.getTime()) &&
              (!before || n.createdAt.getTime() < before.getTime()) &&
              (!unreadOnly || n.readAt === null)
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, Math.max(limit, 0))
          .map(copyNotification);
      },
      async countUnread(subject) {
        return notifications.filter((n) => n.subject === subject && n.readAt === null).length;
      },
      async mark(subject, target, { unread }) {
        let changed = 0;
        const now = new Date();
        for (const n of notifications) {
          if (n.subject !== subject || !matches(target, n.id)) continue;
          if (unread ? n.readAt === null : n.readAt !== null) continue;
          n.readAt = unread ? null : now;
          changed += 1;
        }
        return changed;
      },
      async delete(subject, target) {
        const before = notifications.length;
        notifications = notifications.filter(
          (n) => n.subject !== subject || !matches(target, n.id)
        );
        return before - notifications.length;
      },
      async insert(notification) {
        if (notifications.some((n) => n.id === notification.id)) {
          throw new Error(`duplicate notification id ${notification.id}`);
        }
        notifications.push(
          copyNotification({
            ...notification,
            readAt: notification.readAt ?? null,
            createdAt: notification.createdAt ?? new Date(),
          })
        );
      },
    },

    async seed(fixtures) {
      for (const s of fixtures.sessions ?? []) {
        await store.sessions.create({ ...s, expiresAt: new Date(s.expiresAt) });
      }
      for (const identity of fixtures.identities ?? []) await store.identities.upsert(identity);
      for (const p of fixtures.userPreferences ?? []) {
        await store.userPreferences.set(p.subject, p.key, p.value);
      }
      for (const s of fixtures.settings ?? []) await store.settings.set(s.key, s.value);
      for (const n of fixtures.notifications ?? []) {
        await store.notifications.insert({
          ...n,
          createdAt: n.createdAt === undefined ? undefined : new Date(n.createdAt),
          readAt: n.readAt === undefined || n.readAt === null ? null : new Date(n.readAt),
        });
      }
    },

    reset(subject) {
      if (subject === undefined) {
        sessions.clear();
        identities.clear();
        userPreferences.clear();
        settings.clear();
        coachMarks.clear();
        notifications = [];
        return;
      }
      for (const [id, s] of sessions) if (s.subject === subject) sessions.delete(id);
      identities.delete(subject);
      for (const [key, p] of userPreferences)
        if (p.subject === subject) userPreferences.delete(key);
      for (const [key, row] of coachMarks) if (row.subject === subject) coachMarks.delete(key);
      notifications = notifications.filter((n) => n.subject !== subject);
    },
  };
  return store;
}
