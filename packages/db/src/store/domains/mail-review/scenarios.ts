import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { DAY_MS } from './record';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
/** Relative to when the suite loads: the lookback windows are relative to now() on both sides. */
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

function log(
  n: number,
  owner: string,
  category: string,
  created: Date,
  extra: Record<string, unknown> = {}
) {
  return {
    id: id(n),
    provider: 'microsoft',
    ref_id: `${owner}/msg/${n}`,
    owner_upn: owner,
    category,
    excerpt: `Subject: ${n}`,
    created_at: created,
    updated_at: created,
    ...extra,
  };
}

const listing = {
  email_classification_log: [
    log(1, 'ann@x.test', 'human', at(1), { match_score: 0.5, sender_key: 'jira' }),
    log(2, 'ann@x.test', 'human', at(3)),
    log(3, 'ann@x.test', 'human', at(2), { needs_review: true }),
    log(4, 'ann@x.test', 'human', at(3)),
    log(5, 'ann@x.test', 'marketing', at(4), { override_action: 'reclassify' }),
    log(6, 'bob@x.test', 'human', at(5)),
    log(7, 'ann@x.test', 'human', at(6), { provider: 'atlassian', ref_id: 'ann@x.test/msg/1' }),
  ],
};

const windowed = {
  email_classification_log: [
    log(1, 'ann@x.test', 'human', daysAgo(1), {
      content_hash: 'h1',
      needs_review: true,
      sender_key: 'jira',
    }),
    log(2, 'ann@x.test', 'human', daysAgo(2), { content_hash: 'h1', ref_id: 'ann@x.test/msg/%' }),
    log(3, 'ann@x.test', 'human', daysAgo(40), {
      content_hash: 'h2',
      needs_review: true,
      sender_key: 'jira',
    }),
    log(4, 'bob@x.test', 'human', daysAgo(1), {
      content_hash: 'h3',
      needs_review: true,
      sender_key: 'Acme',
    }),
    log(5, 'ann@x.test', 'human', daysAgo(3), {
      content_hash: 'h4',
      needs_review: true,
      sender_key: 'jira',
    }),
    log(6, 'ann@x.test', 'human', daysAgo(3), { content_hash: 'h5', needs_review: true }),
  ],
  knowledge_chunks: [
    {
      id: id(101),
      provider: 'microsoft',
      ref_id: 'ann@x.test/msg/1#0',
      content: 'c',
      embedding: '[1,2,3]',
    },
    {
      id: id(102),
      provider: 'microsoft',
      ref_id: 'ann@x.test/msg/3',
      content: 'c',
      embedding: '[1,2,3]',
    },
    {
      id: id(103),
      provider: 'microsoft',
      ref_id: 'ann@x.test/msg/xyz#2',
      content: 'c',
      embedding: '[1,2,3]',
    },
    {
      id: id(104),
      provider: 'other',
      ref_id: 'bob@x.test/msg/4',
      content: 'c',
      embedding: '[1,2,3]',
    },
  ],
};

const entry = {
  id: id(50),
  provider: 'microsoft',
  refId: 'ann@x.test/msg/50',
  ownerUpn: 'ann@x.test',
  accountId: 'acct',
  category: 'system_notification',
  matchedRuleId: id(60),
  senderKey: 'jira',
  templateId: id(61),
  templateVersion: 2,
  matchScore: 0.75,
  contentHash: 'hash',
  needsReview: true,
  excerpt: 'Subject: new',
};

export const mailReviewScenarios: Scenario<DataStore>[] = [
  {
    method: 'mailReview.record',
    name: 'inserts, then a re-classification replaces the outcome only',
    run: async (store) => {
      await store.mailReview.record(entry);
      const first = await store.mailReview.getOwnRow('ann@x.test', entry.refId);
      await store.mailReview.record({
        ...entry,
        id: id(51),
        ownerUpn: 'someone@else.test',
        accountId: null,
        category: 'human',
        needsReview: false,
        matchScore: null,
        excerpt: 'Subject: again',
      });
      const second = await store.mailReview.getOwnRow('ann@x.test', entry.refId);
      return {
        first: first && { ...first, createdAt: null },
        second: second && { ...second, createdAt: null },
        counts: await store.mailReview.countByCategory('ann@x.test'),
        other: await store.mailReview.countByCategory('someone@else.test'),
      };
    },
  },
  {
    method: 'mailReview.hasIndexedDuplicate',
    name: 'own, other message, within the window, and still indexed',
    fixture: windowed,
    run: async (store) => {
      const ask = (contentHash: string, ownerUpn: string, refId: string, lookbackDays = 30) =>
        store.mailReview.hasIndexedDuplicate({ contentHash, ownerUpn, refId, lookbackDays });
      return [
        // msg/1 is indexed as a chunk of itself.
        await ask('h1', 'ann@x.test', 'ann@x.test/msg/new'),
        // ...but not a duplicate of itself; msg/% matches msg/xyz#2 as a LIKE pattern.
        await ask('h1', 'ann@x.test', 'ann@x.test/msg/1'),
        await ask('h1', 'bob@x.test', 'x'),
        // Too old.
        await ask('h2', 'ann@x.test', 'x'),
        await ask('h2', 'ann@x.test', 'x', 60),
        // Indexed under another provider only.
        await ask('h3', 'bob@x.test', 'x'),
        // Logged but not indexed.
        await ask('h4', 'ann@x.test', 'x'),
      ];
    },
  },
  {
    method: 'mailReview.listForOwner',
    name: 'needs-review first, newest next, ties by id, paged, own only',
    fixture: listing,
    run: async (store) => [
      await store.mailReview.listForOwner('ann@x.test', 'human', { limit: 10, offset: 0 }),
      (await store.mailReview.listForOwner('ann@x.test', 'human', { limit: 2, offset: 2 })).map(
        (r) => r.excerpt
      ),
      await store.mailReview.listForOwner('ann@x.test', 'system_notification', {
        limit: 10,
        offset: 0,
      }),
      (await store.mailReview.listForOwner('bob@x.test', 'human', { limit: 10, offset: 0 })).length,
    ],
  },
  {
    method: 'mailReview.countByCategory',
    name: 'per category, own only',
    fixture: listing,
    run: async (store) => [
      await store.mailReview.countByCategory('ann@x.test'),
      await store.mailReview.countByCategory('nobody@x.test'),
    ],
  },
  {
    method: 'mailReview.getOwnRow',
    name: 'own rows only, by provider when two share a ref id',
    fixture: listing,
    run: async (store) => [
      await store.mailReview.getOwnRow('ann@x.test', 'ann@x.test/msg/1'),
      await store.mailReview.getOwnRow('bob@x.test', 'ann@x.test/msg/1'),
      await store.mailReview.getOwnRow('ann@x.test', 'missing'),
    ],
  },
  {
    method: 'mailReview.setOverride',
    name: 'own rows only, counted',
    fixture: listing,
    run: async (store) => [
      await store.mailReview.setOverride('ann@x.test', 'ann@x.test/msg/1', {
        action: 'reclassify',
        category: 'marketing',
        senderKey: null,
      }),
      await store.mailReview.setOverride('bob@x.test', 'ann@x.test/msg/2', {
        action: 'exclude',
        category: null,
        senderKey: null,
      }),
      (await store.mailReview.listForOwner('ann@x.test', 'human', { limit: 10, offset: 0 })).map(
        (r) => r.overrideAction
      ),
    ],
  },
  {
    method: 'mailReview.needsReviewCounts',
    name: 'flagged rows with a sender within the window, by sender key',
    fixture: windowed,
    run: async (store) => [
      await store.mailReview.needsReviewCounts(7),
      await store.mailReview.needsReviewCounts(60),
    ],
  },
  {
    method: 'mailReview.needsReviewCounts',
    name: 'empty',
    run: async (store) => store.mailReview.needsReviewCounts(7),
  },
  {
    method: 'mailReview.suggestionEvidence',
    name: 'corrections newest first, then unsure rows to fill; ties by id; bounded',
    fixture: {
      email_classification_log: [
        log(1, 'ann@x.test', 'human', at(1), {
          override_category: 'marketing',
          overridden_at: at(10),
        }),
        log(2, 'bob@x.test', 'marketing', at(2), {
          override_category: 'human',
          overridden_at: at(12),
        }),
        log(3, 'ann@x.test', 'human', at(3), {
          override_category: 'system_notification',
          overridden_at: at(10),
          needs_review: true,
        }),
        log(4, 'ann@x.test', 'human', at(4), { needs_review: true }),
        log(5, 'bob@x.test', 'marketing', at(6), { needs_review: true }),
        log(6, 'bob@x.test', 'human', at(6), { needs_review: true }),
        log(7, 'ann@x.test', 'human', at(7)),
      ],
    },
    run: async (store) => [
      await store.mailReview.suggestionEvidence(10),
      await store.mailReview.suggestionEvidence(4),
      await store.mailReview.suggestionEvidence(2),
    ],
  },
  {
    method: 'mailReview.suggestionEvidence',
    name: 'nothing to learn from',
    fixture: { email_classification_log: [log(1, 'ann@x.test', 'human', at(1))] },
    run: async (store) => store.mailReview.suggestionEvidence(10),
  },
];
