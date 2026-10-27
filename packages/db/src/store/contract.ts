/**
 * The data-store contract: one set of cases every implementation must
 * pass, so a page tested against the memory store sees what it would see
 * against Postgres. Run by memory.contract.test.ts (always, CI included)
 * and postgres.contract.test.ts (against a migrated database, when
 * DATABASE_URL is set).
 *
 * The Postgres run shares its database with everything else on the
 * machine, so every case writes under subjects, ids and setting keys of
 * its own, asserts only about those, and cleans them up after.
 */

import { randomUUID } from 'node:crypto';
import type { CoachMarkProgressRecord, DataStore } from './types';

export interface ContractHarness {
  store: DataStore;
  /** Remove whatever the suite wrote under these subjects and setting keys. */
  cleanup(written: { subjects: string[]; settingKeys: string[] }): Promise<void>;
}

export function describeDataStoreContract(
  label: string,
  open: () => Promise<ContractHarness>,
  close: () => Promise<void> = async () => {}
): void {
  describe(`data store contract: ${label}`, () => {
    let harness: ContractHarness;
    const subjects: string[] = [];
    const settingKeys: string[] = [];
    const suite = randomUUID().slice(0, 8);
    let n = 0;
    const subject = () => {
      const s = `contract-${suite}-${(n += 1)}`;
      subjects.push(s);
      return s;
    };
    const settingKey = () => {
      const k = `contract_${suite}_${(n += 1)}`;
      settingKeys.push(k);
      return k;
    };
    const store = () => harness.store;

    beforeAll(async () => {
      harness = await open();
    });
    afterAll(async () => {
      await harness.cleanup({ subjects, settingKeys });
      await close();
    });

    describe('sessions', () => {
      it('creates, finds, touches and deletes', async () => {
        const id = randomUUID();
        const who = subject();
        const expiresAt = new Date(Date.now() + 3_600_000);
        await store().sessions.create({ id, subject: who, roles: ['a', 'b'], expiresAt });

        const found = await store().sessions.find(id);
        expect(found).toMatchObject({ id, subject: who, roles: ['a', 'b'] });
        expect(found?.expiresAt.getTime()).toBe(expiresAt.getTime());
        expect(found?.lastUsedAt).toBeInstanceOf(Date);

        const later = new Date(Date.now() + 60_000);
        await store().sessions.touch(id, later);
        expect((await store().sessions.find(id))?.lastUsedAt.getTime()).toBe(later.getTime());

        await store().sessions.delete(id);
        expect(await store().sessions.find(id)).toBeNull();
      });

      it('finds nothing for an unknown id, and touching or deleting one is harmless', async () => {
        const id = randomUUID();
        expect(await store().sessions.find(id)).toBeNull();
        await store().sessions.touch(id, new Date());
        await store().sessions.delete(id);
        expect(await store().sessions.find(id)).toBeNull();
      });

      it('refuses a second session with the same id', async () => {
        const id = randomUUID();
        const who = subject();
        const expiresAt = new Date(Date.now() + 3_600_000);
        await store().sessions.create({ id, subject: who, roles: [], expiresAt });
        await expect(
          store().sessions.create({ id, subject: who, roles: [], expiresAt })
        ).rejects.toThrow();
        await store().sessions.delete(id);
      });

      it('hands out copies', async () => {
        const id = randomUUID();
        await store().sessions.create({
          id,
          subject: subject(),
          roles: ['x'],
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        const first = await store().sessions.find(id);
        first?.roles.push('mutated');
        expect((await store().sessions.find(id))?.roles).toEqual(['x']);
        await store().sessions.delete(id);
      });
    });

    describe('identities', () => {
      it('upserts and reads back', async () => {
        const who = subject();
        expect(await store().identities.get(who)).toBeNull();
        await store().identities.upsert({
          subject: who,
          email: `${who}@example.test`,
          displayName: 'First',
          idpGroups: ['g1'],
        });
        await store().identities.upsert({
          subject: who,
          email: `${who}@example.test`,
          displayName: 'Second',
          idpGroups: ['g2', 'g3'],
        });
        expect(await store().identities.get(who)).toEqual({
          subject: who,
          email: `${who}@example.test`,
          displayName: 'Second',
          idpGroups: ['g2', 'g3'],
        });
      });

      it('clears groups, leaving the rest', async () => {
        const who = subject();
        await store().identities.upsert({
          subject: who,
          email: `${who}@example.test`,
          displayName: null,
          idpGroups: ['g1'],
        });
        await store().identities.clearGroups(who);
        await store().identities.clearGroups(subject());
        expect(await store().identities.get(who)).toEqual({
          subject: who,
          email: `${who}@example.test`,
          displayName: null,
          idpGroups: [],
        });
      });

      it('lists by display name then email, a missing name last', async () => {
        const [a, b, c, d] = [subject(), subject(), subject(), subject()];
        await store().identities.upsert({
          subject: c,
          email: `zz-${suite}@example.test`,
          displayName: null,
          idpGroups: [],
        });
        await store().identities.upsert({
          subject: b,
          email: `b-${suite}@example.test`,
          displayName: `name ${suite} b`,
          idpGroups: [],
        });
        await store().identities.upsert({
          subject: d,
          email: `aa-${suite}@example.test`,
          displayName: null,
          idpGroups: [],
        });
        await store().identities.upsert({
          subject: a,
          email: `c-${suite}@example.test`,
          displayName: `name ${suite} a`,
          idpGroups: [],
        });
        const mine = (await store().identities.list())
          .map((row) => row.subject)
          .filter((s) => [a, b, c, d].includes(s));
        expect(mine).toEqual([a, b, d, c]);
      });
    });

    describe('user preferences', () => {
      it('stores JSON values per subject and key, as a JSON round trip leaves them', async () => {
        const [me, you] = [subject(), subject()];
        expect(await store().userPreferences.get(me, 'theme')).toBeUndefined();
        await store().userPreferences.set(me, 'theme', {
          mode: 'dark',
          when: new Date('2026-01-02T03:04:05.000Z'),
          gone: undefined,
          list: [1, 'two'],
        });
        await store().userPreferences.set(you, 'theme', { mode: 'light' });
        expect(await store().userPreferences.get(me, 'theme')).toEqual({
          mode: 'dark',
          when: '2026-01-02T03:04:05.000Z',
          list: [1, 'two'],
        });
        expect(await store().userPreferences.get(you, 'theme')).toEqual({ mode: 'light' });
        expect(await store().userPreferences.get(me, 'voice')).toBeUndefined();
      });

      it('replaces on a second set, and takes scalar values', async () => {
        const me = subject();
        await store().userPreferences.set(me, 'k', { a: 1 });
        await store().userPreferences.set(me, 'k', 42);
        expect(await store().userPreferences.get(me, 'k')).toBe(42);
      });

      it('hands out copies', async () => {
        const me = subject();
        await store().userPreferences.set(me, 'k', { list: [1] });
        const read = await store().userPreferences.get(me, 'k');
        if (
          typeof read === 'object' &&
          read !== null &&
          'list' in read &&
          Array.isArray(read.list)
        ) {
          read.list.push(2);
        }
        expect(await store().userPreferences.get(me, 'k')).toEqual({ list: [1] });
      });
    });

    describe('settings', () => {
      it('sets, gets, replaces and lists', async () => {
        const [k1, k2] = [settingKey(), settingKey()];
        expect(await store().settings.get(k1)).toBeUndefined();
        await store().settings.set(k1, true);
        await store().settings.set(k2, ['a', 'b']);
        await store().settings.set(k1, { nested: { n: 3 } });
        expect(await store().settings.get(k1)).toEqual({ nested: { n: 3 } });
        const all = await store().settings.all();
        expect(all.get(k1)).toEqual({ nested: { n: 3 } });
        expect(all.get(k2)).toEqual(['a', 'b']);
      });
    });

    describe('coach marks', () => {
      const record = (tourId: string, patch: Partial<CoachMarkProgressRecord> = {}) => ({
        tourId,
        version: 1,
        status: 'viewed',
        stepReached: 0,
        stepsTotal: 3,
        viewCount: 1,
        completedCount: 0,
        dismissedCount: 0,
        firstViewedAt: '2026-01-01T00:00:00.000Z',
        lastViewedAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
        dismissedAt: null,
        reportedAt: '2026-01-01T00:00:00.000Z',
        ...patch,
      });

      it('applies a first report and a follow-up, handing the reducer the stored row', async () => {
        const me = subject();
        const seen: (CoachMarkProgressRecord | null)[] = [];
        const first = await store().coachMarks.apply(me, 'tour-b', (existing) => {
          seen.push(existing);
          return record('tour-b');
        });
        expect(first).toEqual(record('tour-b'));

        const second = await store().coachMarks.apply(me, 'tour-b', (existing) => {
          seen.push(existing);
          return record('tour-b', {
            status: 'completed',
            stepReached: 2,
            completedCount: 1,
            completedAt: '2026-01-01T00:05:00.000Z',
            reportedAt: '2026-01-01T00:05:00.000Z',
          });
        });
        expect(seen).toEqual([null, record('tour-b')]);
        expect(second.status).toBe('completed');

        await store().coachMarks.apply(me, 'tour-a', () => record('tour-a'));
        await store().coachMarks.apply(subject(), 'tour-a', () => record('tour-a'));
        const mine = await store().coachMarks.list(me);
        expect(mine.map((row) => row.tourId)).toEqual(['tour-a', 'tour-b']);
        expect(mine[1]).toEqual(second);
      });

      it('keeps the first view of a row once written', async () => {
        const me = subject();
        await store().coachMarks.apply(me, 't', () => record('t'));
        await store().coachMarks.apply(me, 't', () =>
          record('t', { firstViewedAt: '2027-01-01T00:00:00.000Z', viewCount: 2 })
        );
        expect((await store().coachMarks.list(me))[0]).toMatchObject({
          firstViewedAt: '2026-01-01T00:00:00.000Z',
          viewCount: 2,
        });
      });

      it('serializes concurrent applies to the same row', async () => {
        const me = subject();
        await Promise.all(
          Array.from({ length: 5 }, () =>
            store().coachMarks.apply(me, 'race', (existing) =>
              record('race', { viewCount: (existing?.viewCount ?? 0) + 1 })
            )
          )
        );
        expect((await store().coachMarks.list(me))[0].viewCount).toBe(5);
      });

      it('lists every row, most recently changed first', async () => {
        const [me, you] = [subject(), subject()];
        await store().coachMarks.apply(me, 'one', () => record('one'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await store().coachMarks.apply(you, 'one', () => record('one'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await store().coachMarks.apply(me, 'two', () => record('two'));
        const ours = (await store().coachMarks.listAll())
          .filter((row) => row.subject === me || row.subject === you)
          .map((row) => [row.subject, row.progress.tourId]);
        expect(ours).toEqual([
          [me, 'two'],
          [you, 'one'],
          [me, 'one'],
        ]);
      });
    });

    describe('notifications', () => {
      const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
      const seed = async (who: string, minutes: number[], readMinutes: number[] = []) => {
        const ids: string[] = [];
        for (const minute of minutes) {
          const id = randomUUID();
          ids.push(id);
          await store().notifications.insert({
            id,
            subject: who,
            kind: 'agent_run',
            category: null,
            connector: 'jira',
            tool: null,
            entity: null,
            headline: `at ${minute}`,
            refUrl: null,
            agentId: null,
            agentName: null,
            runId: null,
            meta: minute === minutes[0] ? { counts: { done: 1 } } : null,
            createdAt: at(minute),
            readAt: readMinutes.includes(minute) ? at(minute + 1) : null,
          });
        }
        return ids;
      };

      it('lists one person’s feed newest first, bounded and filtered', async () => {
        const [me, you] = [subject(), subject()];
        await seed(me, [1, 3, 2, 5, 4], [2]);
        await seed(you, [6]);

        const all = await store().notifications.list(me, { limit: 10 });
        expect(all.map((n) => n.headline)).toEqual(['at 5', 'at 4', 'at 3', 'at 2', 'at 1']);
        expect(all[4]).toMatchObject({
          subject: me,
          connector: 'jira',
          meta: { counts: { done: 1 } },
        });
        expect(all[3].readAt?.getTime()).toBe(at(3).getTime());
        expect(all[0].createdAt.getTime()).toBe(at(5).getTime());

        const headlines = async (options: Parameters<DataStore['notifications']['list']>[1]) =>
          (await store().notifications.list(me, options)).map((n) => n.headline);
        expect(await headlines({ limit: 2 })).toEqual(['at 5', 'at 4']);
        expect(await headlines({ limit: 10, since: at(3) })).toEqual(['at 5', 'at 4']);
        expect(await headlines({ limit: 10, before: at(3) })).toEqual(['at 2', 'at 1']);
        expect(await headlines({ limit: 10, since: at(1), before: at(5) })).toEqual([
          'at 4',
          'at 3',
          'at 2',
        ]);
        expect(await headlines({ limit: 10, unreadOnly: true })).toEqual([
          'at 5',
          'at 4',
          'at 3',
          'at 1',
        ]);
        expect(await store().notifications.countUnread(me)).toBe(4);
        expect(await store().notifications.countUnread(you)).toBe(1);
      });

      it('marks read and unread, counting only rows that changed, and only the person’s own', async () => {
        const [me, you] = [subject(), subject()];
        const [a, b, c] = await seed(me, [1, 2, 3], [3]);
        const [theirs] = await seed(you, [4]);

        expect(
          await store().notifications.mark(me, { ids: [a, c, theirs] }, { unread: false })
        ).toBe(1);
        expect(await store().notifications.countUnread(me)).toBe(1);
        expect(await store().notifications.countUnread(you)).toBe(1);
        expect(await store().notifications.mark(me, { ids: [] }, { unread: false })).toBe(0);
        expect(await store().notifications.mark(me, { all: true }, { unread: false })).toBe(1);
        expect(await store().notifications.countUnread(me)).toBe(0);
        expect(await store().notifications.mark(me, { ids: [b] }, { unread: true })).toBe(1);
        expect(await store().notifications.mark(me, { all: true }, { unread: true })).toBe(2);
        expect(await store().notifications.countUnread(me)).toBe(3);
      });

      it('deletes by id or wholesale, only the person’s own', async () => {
        const [me, you] = [subject(), subject()];
        const [a] = await seed(me, [1, 2, 3]);
        const [theirs] = await seed(you, [4]);
        expect(await store().notifications.delete(me, { ids: [a, theirs] })).toBe(1);
        expect(await store().notifications.delete(me, { ids: [] })).toBe(0);
        expect((await store().notifications.list(me, { limit: 10 })).length).toBe(2);
        expect(await store().notifications.delete(me, { all: true })).toBe(2);
        expect(await store().notifications.list(me, { limit: 10 })).toEqual([]);
        expect((await store().notifications.list(you, { limit: 10 })).length).toBe(1);
      });

      it('defaults a new notification to unread, now', async () => {
        const me = subject();
        const before = Date.now();
        await store().notifications.insert({
          id: randomUUID(),
          subject: me,
          kind: 'act',
          category: 'jira',
          connector: null,
          tool: 'create_issue',
          entity: 'ABC-1',
          headline: 'made',
          refUrl: 'https://example.test/ABC-1',
          agentId: null,
          agentName: 'Bot',
          runId: null,
          meta: null,
        });
        const [row] = await store().notifications.list(me, { limit: 1 });
        expect(row).toMatchObject({
          readAt: null,
          tool: 'create_issue',
          agentName: 'Bot',
          meta: null,
        });
        expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      });
    });
  });
}
