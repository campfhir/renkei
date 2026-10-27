import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-16${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

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
    watch(4, 'ann', 'jira', 'eng'),
    watch(5, 'bob', 'jira', 'OPS'),
  ],
};

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
];
