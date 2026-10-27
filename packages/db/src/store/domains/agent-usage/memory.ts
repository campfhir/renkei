import { compareAsc, groupBy, orderBy } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { bucketSums, isToday, ZERO_TOKEN_BUCKETS } from './calendar';
import type {
  AgentUsageStore,
  RunLogBucketsRecord,
  RunTokenTotalsRecord,
  TokenBucketsRecord,
} from './types';

const DAY_MS = 86_400_000;

function tokensOf(rows: readonly Row<'llm_calls'>[], now: Date): TokenBucketsRecord {
  if (rows.length === 0) return ZERO_TOKEN_BUCKETS;
  const sum = (value: (row: Row<'llm_calls'>) => number | null) =>
    bucketSums(rows, (row) => row.created_at, value, now);
  return {
    input: sum((row) => row.input_tokens),
    output: sum((row) => row.output_tokens),
    cacheRead: sum((row) => row.cache_read_input_tokens),
    cacheWrite: sum((row) => row.cache_write_input_tokens),
  };
}

function runLogOf(rows: readonly Row<'agent_run_log'>[], now: Date): RunLogBucketsRecord {
  return {
    runs: bucketSums(
      rows,
      (row) => row.created_at,
      () => 1,
      now
    ),
    failures: bucketSums(
      rows,
      (row) => row.created_at,
      (row) => (row.status === 'failed' ? 1 : null),
      now
    ),
  };
}

function totalsOf(rows: readonly Row<'llm_calls'>[]): RunTokenTotalsRecord {
  return rows.reduce(
    (sum, row) => ({
      input: sum.input + row.input_tokens,
      output: sum.output + row.output_tokens,
      cacheRead: sum.cacheRead + (row.cache_read_input_tokens ?? 0),
      cacheWrite: sum.cacheWrite + (row.cache_write_input_tokens ?? 0),
      calls: sum.calls + 1,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
  );
}

/** percentile_disc(fraction) WITHIN GROUP (ORDER BY value): the first value at or past it. */
function percentileDisc(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(Math.ceil(fraction * sorted.length), 1) - 1;
  return sorted[index] ?? 0;
}

/** The calendar date (YYYY-MM-DD) an instant falls on in a time zone. */
function dateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function minusDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date) - days * DAY_MS).toISOString().slice(0, 10);
}

/** ORDER BY SUM(input) + SUM(output) DESC, provider, model. */
function bySpend<T extends { provider: string | null; model: string | null; spend: number }>(
  rows: T[]
): T[] {
  return orderBy(rows, [(r) => r.spend, 'desc'], [(r) => r.provider], [(r) => r.model]);
}

export function memoryAgentUsage(tables: MemoryTables): AgentUsageStore {
  const agentIdsOf = (ids: readonly string[]) =>
    new Set(ids.map((id) => tables.param('llm_calls', 'agent_id', id)));
  const ledger = (ids: readonly string[] | null) => {
    if (ids === null) return tables.select('llm_calls');
    const wanted = agentIdsOf(ids);
    return tables.select('llm_calls', (r) => r.agent_id !== null && wanted.has(r.agent_id));
  };

  return {
    async tokenBuckets(agentIds) {
      if (agentIds !== null && agentIds.length === 0) return ZERO_TOKEN_BUCKETS;
      return tokensOf(ledger(agentIds), new Date());
    },
    async tokenBucketsByAgent() {
      const now = new Date();
      const groups = groupBy(
        tables.select('llm_calls', (r) => r.agent_id !== null),
        (row) => row.agent_id ?? ''
      );
      return orderBy([...groups.entries()], [([agentId]) => agentId]).map(([agentId, rows]) => ({
        agentId,
        usage: tokensOf(rows, now),
      }));
    },
    async tokenBucketsByModel(agentIds) {
      if (agentIds !== null && agentIds.length === 0) return [];
      const now = new Date();
      const groups = groupBy(ledger(agentIds), (row) => JSON.stringify([row.provider, row.model]));
      const rows = [...groups.values()].map((group) => ({
        provider: group[0].provider,
        model: group[0].model,
        spend: group.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0),
        usage: tokensOf(group, now),
      }));
      return bySpend(rows).map((row) => ({
        provider: row.provider,
        model: row.model,
        ...row.usage,
      }));
    },
    async toolUsage(agentIds, days) {
      if (agentIds.length === 0) return [];
      const wanted = new Set(agentIds.map((id) => tables.param('tool_calls', 'agent_id', id)));
      const since = Date.now() - days * DAY_MS;
      const rows = tables.select(
        'tool_calls',
        (r) => r.agent_id !== null && wanted.has(r.agent_id) && r.started_at.getTime() >= since
      );
      const tools = [...groupBy(rows, (row) => row.tool).entries()].map(([tool, group]) => ({
        tool,
        calls: group.length,
        errors: group.filter((row) => row.status !== 'ok').length,
        medianMs: percentileDisc(
          group.map((row) => row.duration_ms),
          0.5
        ),
        p95Ms: percentileDisc(
          group.map((row) => row.duration_ms),
          0.95
        ),
      }));
      return orderBy(tools, [(t) => t.calls, 'desc'], [(t) => t.tool]);
    },
    async usageSummaries(ownerSubject, days) {
      const agents = orderBy(
        tables.select('agents', (r) => ownerSubject === null || r.owner_subject === ownerSubject),
        [(r) => r.name],
        [(r) => r.id]
      );
      const since = Date.now() - days * DAY_MS;
      return agents.map((agent) => {
        const calls = tables.select(
          'tool_calls',
          (r) => r.agent_id === agent.id && r.started_at.getTime() >= since
        );
        const tokens = tables.select(
          'llm_calls',
          (r) => r.agent_id === agent.id && r.created_at.getTime() >= since
        );
        return {
          agentId: agent.id,
          name: agent.name,
          calls: calls.length,
          errors: calls.filter((row) => row.status !== 'ok').length,
          inputTokens: tokens.reduce((sum, row) => sum + row.input_tokens, 0),
          outputTokens: tokens.reduce((sum, row) => sum + row.output_tokens, 0),
        };
      });
    },
    async tokenTrend(agentIds, days, timeZone) {
      if (agentIds.length === 0) return [];
      const start = minusDays(dateIn(new Date(), timeZone), Math.max(0, days - 1));
      const rows = ledger(agentIds).flatMap((row) => {
        const day = dateIn(row.created_at, timeZone);
        return day >= start ? [{ day, row }] : [];
      });
      return [...groupBy(rows, (entry) => entry.day).entries()]
        .sort(([a], [b]) => compareAsc(a, b))
        .map(([day, group]) => ({
          day,
          inputTokens: group.reduce((sum, { row }) => sum + row.input_tokens, 0),
          outputTokens: group.reduce((sum, { row }) => sum + row.output_tokens, 0),
        }));
    },
    async tokensByRun(runIds) {
      if (runIds.length === 0) return [];
      const wanted = new Set(runIds.map((id) => tables.param('llm_calls', 'run_id', id)));
      const groups = groupBy(
        tables.select('llm_calls', (r) => r.run_id !== null && wanted.has(r.run_id)),
        (row) => row.run_id ?? ''
      );
      return orderBy([...groups.entries()], [([runId]) => runId]).map(([runId, rows]) => ({
        runId,
        totals: totalsOf(rows),
      }));
    },
    async runTokensByModel(runId) {
      const id = tables.param('llm_calls', 'run_id', runId);
      const groups = groupBy(
        tables.select('llm_calls', (r) => r.run_id === id),
        (row) => JSON.stringify([row.provider, row.model])
      );
      const rows = [...groups.values()].map((group) => ({
        provider: group[0].provider,
        model: group[0].model,
        spend: group.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0),
        totals: totalsOf(group),
      }));
      return bySpend(rows).map(({ provider, model, totals }) => ({ provider, model, totals }));
    },
    async invocationCounts(agentId) {
      const id = tables.param('agent_run_log', 'agent_id', agentId);
      const now = new Date();
      const all = tables.select('agent_run_log');
      return {
        agent: runLogOf(
          all.filter((row) => row.agent_id === id),
          now
        ),
        orgToday: all.filter((row) => isToday(row.created_at, now)).length,
      };
    },
    async runLogBuckets() {
      const now = new Date();
      const rows = tables.select('agent_run_log');
      return {
        totals: runLogOf(rows, now),
        byAgent: orderBy(
          [...groupBy(rows, (row) => row.agent_id).entries()],
          [([agentId]) => agentId]
        ).map(([agentId, group]) => ({ agentId, buckets: runLogOf(group, now) })),
      };
    },
  };
}
