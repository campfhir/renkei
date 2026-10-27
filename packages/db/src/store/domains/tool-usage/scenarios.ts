import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Hours after 2026-03-07T00:00Z — the US switches to daylight time on 03-08. */
const at = (hour: number) => new Date(Date.UTC(2026, 2, 7, 0) + hour * 3_600_000);

function call(
  n: number,
  hour: number,
  fields: {
    tool?: string;
    connector?: string | null;
    subject?: string | null;
    ok?: boolean;
    ms?: number;
    agent?: number;
  }
) {
  return {
    id: id(n),
    tool: fields.tool ?? 'jira_search',
    connector: fields.connector === undefined ? 'jira' : fields.connector,
    subject: fields.subject === undefined ? 'ann' : fields.subject,
    status: fields.ok === false ? 'error' : 'ok',
    duration_ms: fields.ms ?? n * 10,
    started_at: at(hour),
    ended_at: at(hour),
    error_summary: fields.ok === false ? `failed ${n}` : null,
    agent_id: fields.agent ? id(100 + fields.agent) : null,
  };
}

const fixture = {
  identities: [
    { subject: 'ann', email: 'ann@example.test', display_name: 'Ann' },
    { subject: 'bob', email: 'bob@example.test', display_name: null },
  ],
  agents: [
    { id: id(101), name: 'Triage', owner_subject: 'ann' },
    { id: id(102), name: 'Digest', owner_subject: 'ann' },
  ],
  tool_calls: [
    call(1, 1, { ms: 100 }),
    call(2, 2, { ms: 300, ok: false }),
    call(3, 3, { ms: 200, agent: 1 }),
    call(4, 4, { tool: 'mail_send', connector: 'outlook', ms: 50, agent: 1 }),
    call(5, 5, { tool: 'mail_send', connector: 'outlook', subject: 'bob', ok: false, ms: 70 }),
    call(6, 6, { tool: 'mail_send', connector: null, subject: 'bob' }),
    call(7, 27, { tool: 'webex_post', connector: 'webex', subject: null, agent: 2 }),
    call(8, 29, { tool: 'webex_post', connector: 'webex', subject: 'cy', ok: false }),
    call(9, 80, { tool: 'jira_search', subject: 'ann' }),
  ],
};

const all = { since: at(0) };
const firstDay = { since: at(0), until: at(24) };

export const toolUsageScenarios: Scenario<DataStore>[] = [
  {
    method: 'toolUsage.byTool',
    name: 'per tool and connector, most calls first, ties ordered, latency on request',
    fixture,
    run: async (store) => [
      await store.toolUsage.byTool({ window: all }, { latency: true }),
      await store.toolUsage.byTool({ window: firstDay, subject: 'ann' }, { latency: true }),
      await store.toolUsage.byTool({ window: all }, { latency: false, limit: 2 }),
      await store.toolUsage.byTool({ window: { since: at(100) } }, { latency: true }),
    ],
  },
  {
    method: 'toolUsage.totals',
    name: 'calls, errors and percentiles; nothing in range',
    fixture,
    run: async (store) => [
      await store.toolUsage.totals({ window: all }, { latency: true }),
      await store.toolUsage.totals(
        { window: all, tool: 'jira_search', subject: 'ann' },
        { latency: true }
      ),
      await store.toolUsage.totals({ window: firstDay, subject: null }, { latency: false }),
      await store.toolUsage.totals({ window: { since: at(100) } }, { latency: true }),
    ],
  },
  {
    method: 'toolUsage.series',
    name: 'local days and hours across a zone change',
    fixture,
    run: async (store) => [
      await store.toolUsage.series({ window: all }, { timeZone: 'UTC', granularity: 'day' }),
      await store.toolUsage.series(
        { window: all },
        { timeZone: 'America/New_York', granularity: 'day' }
      ),
      await store.toolUsage.series(
        { window: firstDay, subject: 'ann' },
        { timeZone: 'Asia/Kolkata', granularity: 'hour' }
      ),
      await store.toolUsage.series(
        { window: all, tool: 'webex_post' },
        { timeZone: 'America/New_York', granularity: 'hour' }
      ),
    ],
  },
  {
    method: 'toolUsage.byPerson',
    name: 'with identity names, most calls first, ties by subject, null subject last',
    fixture,
    run: async (store) => [
      await store.toolUsage.byPerson({ window: all }, 50),
      await store.toolUsage.byPerson({ window: all }, 1),
    ],
  },
  {
    method: 'toolUsage.byAgent',
    name: 'stamped calls only, optionally among some agents',
    fixture,
    run: async (store) => [
      await store.toolUsage.byAgent({ window: all }),
      await store.toolUsage.byAgent({ window: all, subject: 'ann', agentIds: [id(101), id(102)] }),
      await store.toolUsage.byAgent({ window: all, agentIds: [] }),
    ],
  },
  {
    method: 'toolUsage.recentFailures',
    name: 'newest failures first, with names, bounded',
    fixture,
    run: async (store) => [
      await store.toolUsage.recentFailures({ window: all }, 25),
      await store.toolUsage.recentFailures({ window: all, tool: 'mail_send' }, 25),
      await store.toolUsage.recentFailures({ window: all, subject: 'ann' }, 1),
    ],
  },
  {
    method: 'toolUsage.recordCall',
    name: 'counted and listed after; a reused id is refused',
    fixture,
    run: async (store) => {
      const entry = {
        id: id(50),
        subject: 'bob',
        agentId: id(102),
        tool: 'card_create',
        connector: 'cards',
        status: 'error',
        startedAt: at(90),
        endedAt: at(90),
        durationMs: 12,
        errorSummary: 'nope',
      };
      await store.toolUsage.recordCall(entry);
      const again = await store.toolUsage.recordCall(entry).then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      );
      return {
        again,
        failures: await store.toolUsage.recentFailures({ window: { since: at(85) } }, 5),
        agents: await store.toolUsage.byAgent({ window: { since: at(85) } }),
      };
    },
  },
];
