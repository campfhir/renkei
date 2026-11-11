import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 0, day, hour));

function call(
  n: number,
  subject: string,
  when: Date,
  input: number,
  output: number,
  model: number | null
) {
  return {
    id: id(n),
    subject,
    purpose: 'chat',
    created_at: when,
    input_tokens: input,
    output_tokens: output,
    llm_model_id: model === null ? null : id(900 + model),
    agent_id: null,
    run_id: null,
    step_id: null,
    provider: null,
    model: null,
    duration_ms: null,
    cache_read_input_tokens: null,
    cache_write_input_tokens: null,
  };
}

function boost(n: number, subject: string, period: string, tokens: string, expires: Date) {
  return {
    id: id(n),
    subject,
    period,
    tokens,
    expires_at: expires,
    granted_by: 'olive',
    note: n === 1 ? 'quarter close' : null,
    // Two grants share an instant, so the id breaks the tie.
    created_at: at(1, n === 3 ? 2 : n),
  };
}

const fixture = {
  llm_calls: [
    call(1, 'ann', at(5), 100, 10, 1),
    call(2, 'ann', at(6), 200, 20, 2),
    call(3, 'ann', at(6, 12), 30, 3, 1),
    call(4, 'ann', at(7), 40, 4, null),
    call(5, 'ann', at(2), 999, 999, 1),
    call(6, 'bob', at(5), 7, 1, 2),
    call(7, 'cat', at(3), 500, 50, 1),
  ],
  token_limit_exemptions: [
    { subject: 'cat', set_by: 'olive', created_at: at(1) },
    { subject: 'ann', set_by: 'olive', created_at: at(2) },
  ],
  token_limit_boosts: [
    boost(1, 'ann', 'week', '5000', at(12)),
    boost(2, 'bob', 'month', '9000000000', at(32)),
    boost(3, 'ann', 'month', '700', at(32)),
    boost(4, 'ann', 'week', '1', at(5)),
  ],
};

export const tokenLimitScenarios: Scenario<DataStore>[] = [
  {
    method: 'tokenLimits.spentSince',
    name: 'input plus output per model from the instant on, the null model last',
    fixture,
    run: async (store) => [
      await store.tokenLimits.spentSince('ann', at(5)),
      await store.tokenLimits.spentSince('ann', at(6)),
      await store.tokenLimits.spentSince('ann', at(1)),
      await store.tokenLimits.spentSince('ann', at(20)),
      await store.tokenLimits.spentSince('nobody', at(1)),
    ],
  },
  {
    method: 'tokenLimits.spentBySubjectSince',
    name: 'everyone who spent since the instant, by subject',
    fixture,
    run: async (store) => [
      await store.tokenLimits.spentBySubjectSince(at(1)),
      await store.tokenLimits.spentBySubjectSince(at(5)),
      await store.tokenLimits.spentBySubjectSince(at(20)),
    ],
  },
  {
    method: 'tokenLimits.listExempt',
    name: 'by subject',
    fixture,
    run: (store) => store.tokenLimits.listExempt(),
  },
  {
    method: 'tokenLimits.isExempt',
    name: 'only those listed',
    fixture,
    run: async (store) => [
      await store.tokenLimits.isExempt('ann'),
      await store.tokenLimits.isExempt('bob'),
    ],
  },
  {
    method: 'tokenLimits.setExempt',
    name: 'adds once, keeps who set it first, and takes away',
    fixture,
    run: async (store) => {
      await store.tokenLimits.setExempt('bob', true, 'olive');
      await store.tokenLimits.setExempt('ann', true, 'peter');
      await store.tokenLimits.setExempt('cat', false, 'peter');
      await store.tokenLimits.setExempt('nobody', false, 'peter');
      const rows = await store.tokenLimits.listExempt();
      return rows.map(({ subject, setBy }) => ({ subject, setBy }));
    },
  },
  {
    method: 'tokenLimits.grantBoost',
    name: 'recorded and read back, the time left out',
    fixture: {},
    run: async (store) => {
      await store.tokenLimits.grantBoost({
        id: id(50),
        subject: 'dee',
        period: 'week',
        tokens: 250_000,
        expiresAt: at(12),
        grantedBy: 'olive',
        note: null,
      });
      const rows = await store.tokenLimits.activeBoosts(at(11));
      return rows.map(({ createdAt: _at, ...rest }) => rest);
    },
  },
  {
    method: 'tokenLimits.activeBoosts',
    name: 'still running at the instant, oldest grant first, ties by id; one person or all',
    fixture,
    run: async (store) => [
      await store.tokenLimits.activeBoosts(at(4)),
      (await store.tokenLimits.activeBoosts(at(5))).map((b) => b.id),
      await store.tokenLimits.activeBoosts(at(4), 'ann'),
      await store.tokenLimits.activeBoosts(at(12), 'ann'),
      await store.tokenLimits.activeBoosts(at(40)),
    ],
  },
  {
    method: 'tokenLimits.revokeBoost',
    name: 'removes the one named and says whether there was one',
    fixture,
    run: async (store) => [
      await store.tokenLimits.revokeBoost(id(1)),
      await store.tokenLimits.revokeBoost(id(1)),
      (await store.tokenLimits.activeBoosts(at(4))).map((b) => b.id),
    ],
  },
];
