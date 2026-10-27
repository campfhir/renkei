import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function watch(n: number, subject: string, scopeKey: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    provider: 'confluence',
    account_id: `acct-${subject}`,
    subject,
    scope_type: 'space',
    scope_key: scopeKey,
    scope_label: `Space ${scopeKey}`,
    updated_at: at(n),
    ...extra,
  };
}

const fixture = {
  content_watches: [
    watch(1, 'ann', 'ENG', { cursor: 'c-ann', last_synced_at: at(30), total_items: 9 }),
    watch(2, 'bob', 'ENG', { cursor: 'c-bob', last_error: 'grant revoked', sync_status: 'error' }),
    watch(3, 'ann', 'OPS', { enabled: false, cursor: 'c-ops' }),
    watch(4, 'ann', 'ENG', { scope_type: 'page' }),
    watch(5, 'ann', 'J1', { provider: 'jira', scope_type: 'project' }),
  ],
};

const space = (scopeKey: string) => ({
  provider: 'confluence',
  scopeType: 'space',
  scopeKey,
});

/** Watches as the scenario compares them: without the generated id and timestamps. */
async function rows(store: DataStore, subject: string) {
  return store.contentWatches.list(subject, 'confluence');
}

export const contentWatchScenarios: Scenario<DataStore>[] = [
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
        metadata: JSON.stringify(metadata),
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
        payload: JSON.stringify(metadata ? { provider, metadata } : { provider }),
      })),
    },
    run: async (store) => [
      await store.contentWatches.objectCounts('confluence', 'spaceId'),
      await store.contentWatches.objectCounts('jira', 'project'),
    ],
  },
];
