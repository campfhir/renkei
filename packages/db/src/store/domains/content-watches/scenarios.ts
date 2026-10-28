import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-16${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function watch(n: number, subject: string, provider: string, scopeKey: string, extra = {}) {
  return {
    id: id(n),
    subject,
    account_id: `acct-${subject}`,
    provider,
    scope_type: provider === 'jira' ? 'project' : 'space',
    scope_key: scopeKey,
    created_at: at(n),
    ...extra,
  };
}

const fixture = {
  content_watches: [
    watch(1, 'ann', 'jira', 'OPS', {
      scope_label: 'Operations',
      last_synced_at: at(30),
      last_run_items: 4,
      total_items: 120,
      sync_status: 'idle',
      cursor: '2026-01-01T00:30:00Z',
    }),
    watch(2, 'ann', 'confluence', 'ENG', { enabled: false, last_error: 'gone' }),
    watch(3, 'ann', 'jira', 'ENG'),
    watch(4, 'ann', 'jira', 'FIN'),
    watch(5, 'bob', 'jira', 'OPS'),
  ],
};

const space = (scopeKey: string) => ({
  provider: 'confluence',
  scopeType: 'space',
  scopeKey,
});

/** Watches as the scenario compares them: without the generated id and timestamps. */
async function rows(store: DataStore, subject: string) {
  const watches = await store.contentWatches.list(subject, 'confluence');
  return watches.map(({ id: _id, ...watch }) => watch);
}

export const contentWatchScenarios: Scenario<DataStore>[] = [
  {
    method: 'contentWatches.listForSubject',
    name: 'own watches by scope key, ties by provider',
    fixture,
    run: async (store) => [
      await store.contentWatches.listForSubject('ann'),
      await store.contentWatches.listForSubject('nobody'),
    ],
  },
  {
    method: 'contentWatches.findForSubject',
    name: 'own watch by provider and scope key',
    fixture,
    run: async (store) => [
      await store.contentWatches.findForSubject('ann', 'jira', 'OPS'),
      await store.contentWatches.findForSubject('bob', 'jira', 'ENG'),
      await store.contentWatches.findForSubject('ann', 'confluence', 'OPS'),
    ],
  },
  {
    method: 'contentWatches.resetForRebuild',
    name: 'cursor and tallies cleared, syncing again; others untouched',
    fixture,
    run: async (store) => [
      await store.contentWatches.resetForRebuild(id(1)),
      await store.contentWatches.resetForRebuild(id(9)),
      await store.contentWatches.findForSubject('ann', 'jira', 'OPS'),
      await store.contentWatches.findForSubject('bob', 'jira', 'OPS'),
    ],
  },
  {
    method: 'contentWatches.list',
    name: 'own watches on one provider, by scope key then type',
    fixture,
    run: async (store) => [
      await rows(store, 'ann'),
      await rows(store, 'bob'),
      await store.contentWatches.list('ann', 'jira'),
      await rows(store, 'nobody'),
    ],
  },
  {
    method: 'contentWatches.watch',
    name: 're-enables an existing watch; a new one inherits the newest sibling cursor',
    fixture,
    run: async (store) => {
      const reEnabled = await store.contentWatches.watch(
        { subject: 'ann', accountId: 'acct-2' },
        { ...space('OPS'), scopeLabel: 'Ops' }
      );
      const again = await store.contentWatches.watch(
        { subject: 'ann', accountId: 'acct-2' },
        { ...space('OPS'), scopeLabel: 'Ops' }
      );
      const fresh = await store.contentWatches.watch(
        { subject: 'cy', accountId: 'acct-c' },
        { ...space('ENG'), scopeLabel: null }
      );
      const brandNew = await store.contentWatches.watch(
        { subject: 'cy', accountId: 'acct-c' },
        { ...space('NEW'), scopeLabel: 'New' }
      );
      return {
        reEnabled,
        again,
        fresh,
        brandNew,
        ann: await rows(store, 'ann'),
        cy: await rows(store, 'cy'),
      };
    },
  },
  {
    method: 'contentWatches.repair',
    name: 'every owner’s watch on the scope, rebound and never-synced',
    fixture,
    run: async (store) => [
      await store.contentWatches.repair({ subject: 'cy', accountId: 'acct-c' }, space('OPS')),
      await store.contentWatches.repair({ subject: 'cy', accountId: 'acct-c' }, space('NONE')),
      // Two owners on one scope collapse onto one key: refused, as the unique index does.
      await store.contentWatches.repair({ subject: 'cy', accountId: 'acct-c' }, space('ENG')).then(
        (count) => count,
        (error: { code?: string }) => error.code
      ),
      await rows(store, 'cy'),
      await rows(store, 'ann'),
    ],
  },
  {
    method: 'contentWatches.disable',
    name: 'the subject’s enabled watch only',
    fixture,
    run: async (store) => [
      await store.contentWatches.disable('ann', space('ENG')),
      await store.contentWatches.disable('ann', space('ENG')),
      await store.contentWatches.disable('ann', space('OPS')),
      await rows(store, 'ann'),
      await rows(store, 'bob'),
    ],
  },
  {
    method: 'contentWatches.objectCounts',
    name: 'distinct objects per scope and pending jobs per scope, one provider',
    fixture: {
      knowledge_chunks: [
        ['page-1#0001', { spaceId: 'ENG' }],
        ['page-1#0002', { spaceId: 'ENG' }],
        ['page-2', { spaceId: 'ENG' }],
        ['page-3', { spaceId: 'OPS' }],
        ['page-4', {}],
      ].map(([refId, metadata], n) => ({
        id: id(n + 1),
        provider: 'confluence',
        ref_id: String(refId),
        content: 'enc',
        embedding: '[1,0,0]',
        metadata: metadata,
      })),
      embedding_jobs: [
        ['confluence', 'pending', { spaceId: 'OPS' }],
        ['confluence', 'pending', { spaceId: 'OPS' }],
        ['confluence', 'done', { spaceId: 'ENG' }],
        ['jira', 'pending', { spaceId: 'ENG' }],
        ['confluence', 'pending', null],
      ].map(([provider, status, metadata], n) => ({
        id: id(20 + n),
        source: 'knowledge',
        type: 'embed',
        status: String(status),
        payload: metadata ? { provider, metadata } : { provider },
      })),
    },
    run: async (store) => [
      await store.contentWatches.objectCounts('confluence', 'spaceId'),
      await store.contentWatches.objectCounts('jira', 'project'),
    ],
  },
  {
    method: 'contentWatches.getSyncState',
    name: 'cursor and tallies by id; unknown ids miss',
    fixture,
    run: async (store) => [
      await store.contentWatches.getSyncState(id(1)),
      await store.contentWatches.getSyncState(id(2)),
      await store.contentWatches.getSyncState(id(99)),
    ],
  },
  {
    method: 'contentWatches.recordRound',
    name: 'cursor, run count added to the total, status, failure cleared; others untouched',
    fixture,
    run: async (store) => {
      await store.contentWatches.recordRound(id(1), {
        cursor: '2026-01-02T00:00:00Z',
        items: 3,
        syncStatus: 'idle',
      });
      await store.contentWatches.recordRound(id(2), {
        cursor: 'next-page',
        items: 0,
        syncStatus: 'syncing',
      });
      const view = async (n: number) => {
        const state = await store.contentWatches.getSyncState(id(n));
        return state ? { ...state, lastSyncedAt: state.lastSyncedAt !== null } : null;
      };
      return [await view(1), await view(2), await view(5)];
    },
  },
  {
    method: 'contentWatches.restartCursor',
    name: 'cursor dropped and syncing, tallies kept, that watch only',
    fixture,
    run: async (store) => {
      await store.contentWatches.restartCursor(id(1));
      return [
        await store.contentWatches.getSyncState(id(1)),
        await store.contentWatches.getSyncState(id(5)),
      ];
    },
  },
  {
    method: 'contentWatches.listDue',
    name: 'enabled, never synced first then stalest, anyone’s; limited; none due',
    fixture: {
      content_watches: [
        ...fixture.content_watches,
        watch(6, 'bob', 'sharepoint', 'drive-1', { last_synced_at: at(10), cursor: 'delta-1' }),
        watch(7, 'cy', 'jira', 'NEW', { scope_label: 'New' }),
        watch(8, 'cy', 'jira', 'LATE', { last_synced_at: at(50) }),
      ],
    },
    run: async (store) => [
      await store.contentWatches.listDue(new Date(at(40)), 10),
      await store.contentWatches.listDue(new Date(at(40)), 3),
      (await store.contentWatches.listDue(new Date(at(0)), 10)).map((w) => w.id),
    ],
  },
  {
    method: 'contentWatches.recordSyncFailure',
    name: 'error status and message, synced now; other watches untouched',
    fixture,
    run: async (store) => {
      await store.contentWatches.recordSyncFailure(id(3), 'token revoked');
      await store.contentWatches.recordSyncFailure(id(99), 'nobody');
      return (await store.contentWatches.listForSubject('ann')).map((w) => ({
        id: w.id,
        syncStatus: w.syncStatus,
        lastError: w.lastError,
        synced: w.lastSyncedAt === null ? null : w.lastSyncedAt.getTime() > Date.UTC(2026, 1, 1),
      }));
    },
  },
];
