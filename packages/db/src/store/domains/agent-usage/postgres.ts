import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type {
  AgentUsageStore,
  RunLogBucketsRecord,
  RunTokenTotalsRecord,
  TokenBucketsRecord,
  UsageBucketsRecord,
} from './types';
import { ZERO_TOKEN_BUCKETS } from './calendar';

const PERIODS = ['today', 'yesterday', 'week', 'month', 'quarter', 'year', 'all_time'] as const;
type Period = (typeof PERIODS)[number];
type BucketColumns<P extends string> = { [K in `${P}_${Period}`]: string | number | null };

function bucketsOf<P extends string>(
  row: BucketColumns<P> | undefined,
  prefix: P
): UsageBucketsRecord {
  const at = (period: Period) => {
    const key: `${P}_${Period}` = `${prefix}_${period}`;
    return Number(row?.[key] ?? 0);
  };
  return {
    today: at('today'),
    yesterday: at('yesterday'),
    week: at('week'),
    month: at('month'),
    quarter: at('quarter'),
    year: at('year'),
    allTime: at('all_time'),
  };
}

/**
 * The six calendar filters plus all time, for one aggregate, as columns
 * `${prefix}_…`; `where` narrows every bucket further.
 */
function bucketColumns(aggregate: string, prefix: string, where?: string) {
  const filters: Record<Period, string | null> = {
    today: 'created_at::date = CURRENT_DATE',
    yesterday: 'created_at::date = CURRENT_DATE - 1',
    week: "created_at::date >= date_trunc('week', CURRENT_DATE)",
    month: "created_at::date >= date_trunc('month', CURRENT_DATE)",
    quarter: "created_at::date >= date_trunc('quarter', CURRENT_DATE)",
    year: "created_at::date >= date_trunc('year', CURRENT_DATE)",
    all_time: null,
  };
  return PERIODS.map((period) => {
    const filter = [where, filters[period]].filter(Boolean).join(' AND ');
    return `COALESCE(${aggregate}${filter ? ` FILTER (WHERE ${filter})` : ''}, 0) AS ${prefix}_${period}`;
  }).join(',\n');
}

// Built on use, not at import: the store barrel is imported everywhere,
// including tests that stub kysely.
const TOKEN_BUCKET_COLUMNS = () =>
  sql.raw(
    [
      bucketColumns('SUM(input_tokens)', 'in'),
      bucketColumns('SUM(output_tokens)', 'out'),
      bucketColumns('SUM(cache_read_input_tokens)', 'cr'),
      bucketColumns('SUM(cache_write_input_tokens)', 'cw'),
    ].join(',\n')
  );

// Built on use, not at import: the store barrel is imported everywhere,
// including tests that stub kysely.
const RUN_LOG_BUCKET_COLUMNS = () =>
  sql.raw(
    [
      bucketColumns('COUNT(*)', 'runs'),
      bucketColumns('COUNT(*)', 'failed', "status = 'failed'"),
    ].join(',\n')
  );

type TokenRow = BucketColumns<'in'> &
  BucketColumns<'out'> &
  BucketColumns<'cr'> &
  BucketColumns<'cw'>;
type RunLogRow = BucketColumns<'runs'> & BucketColumns<'failed'>;

function tokensOf(row: TokenRow | undefined): TokenBucketsRecord {
  if (!row) return ZERO_TOKEN_BUCKETS;
  return {
    input: bucketsOf(row, 'in'),
    output: bucketsOf(row, 'out'),
    cacheRead: bucketsOf(row, 'cr'),
    cacheWrite: bucketsOf(row, 'cw'),
  };
}

function runLogOf(row: RunLogRow | undefined): RunLogBucketsRecord {
  return { runs: bucketsOf(row, 'runs'), failures: bucketsOf(row, 'failed') };
}

function totalsOf(row: {
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read: string | null;
  cache_write: string | null;
  calls: string;
}): RunTokenTotalsRecord {
  return {
    input: Number(row.input_tokens ?? 0),
    output: Number(row.output_tokens ?? 0),
    cacheRead: Number(row.cache_read ?? 0),
    cacheWrite: Number(row.cache_write ?? 0),
    calls: Number(row.calls ?? 0),
  };
}

export function postgresAgentUsage(db: () => Kysely<DB>): AgentUsageStore {
  return {
    async tokenBuckets(agentIds) {
      if (agentIds !== null && agentIds.length === 0) return ZERO_TOKEN_BUCKETS;
      const result = await sql<TokenRow>`
        SELECT ${TOKEN_BUCKET_COLUMNS()}
        FROM llm_calls
        ${agentIds === null ? sql`` : sql`WHERE agent_id IN (${sql.join([...agentIds])})`}
      `.execute(db());
      return tokensOf(result.rows[0]);
    },
    async tokenBucketsByAgent() {
      const result = await sql<TokenRow & { agent_id: string }>`
        SELECT agent_id, ${TOKEN_BUCKET_COLUMNS()}
        FROM llm_calls
        WHERE agent_id IS NOT NULL
        GROUP BY agent_id
        ORDER BY agent_id
      `.execute(db());
      return result.rows.map((row) => ({ agentId: row.agent_id, usage: tokensOf(row) }));
    },
    async tokenBucketsByModel(agentIds) {
      if (agentIds !== null && agentIds.length === 0) return [];
      const result = await sql<TokenRow & { provider: string | null; model: string | null }>`
        SELECT provider, model, ${TOKEN_BUCKET_COLUMNS()}
        FROM llm_calls
          ${agentIds === null ? sql`` : sql`WHERE agent_id IN (${sql.join([...agentIds])})`}
        GROUP BY provider, model
        ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC, provider, model
      `.execute(db());
      return result.rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        ...tokensOf(row),
      }));
    },
    async toolUsage(agentIds, days) {
      if (agentIds.length === 0) return [];
      const rows = await db()
        .selectFrom('tool_calls')
        .select([
          'tool',
          sql<string>`count(*)`.as('calls'),
          sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
          sql<string>`percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)`.as('median_ms'),
          sql<string>`percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)`.as('p95_ms'),
        ])
        .where('agent_id', 'in', [...agentIds])
        .where('started_at', '>=', sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`)
        .groupBy('tool')
        .orderBy(sql`count(*)`, 'desc')
        .orderBy('tool')
        .execute();
      return rows.map((row) => ({
        tool: row.tool,
        calls: Number(row.calls),
        errors: Number(row.errors),
        medianMs: Number(row.median_ms ?? 0),
        p95Ms: Number(row.p95_ms ?? 0),
      }));
    },
    async usageSummaries(ownerSubject, days) {
      let agentQuery = db().selectFrom('agents').select(['id', 'name']);
      if (ownerSubject !== null) agentQuery = agentQuery.where('owner_subject', '=', ownerSubject);
      const agents = await agentQuery.orderBy('name').orderBy('id').execute();
      if (agents.length === 0) return [];
      const agentIds = agents.map((agent) => agent.id);
      const since = sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`;
      const [callRows, tokenRows] = await Promise.all([
        db()
          .selectFrom('tool_calls')
          .select([
            'agent_id',
            sql<string>`count(*)`.as('calls'),
            sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
          ])
          .where('agent_id', 'in', agentIds)
          .where('started_at', '>=', since)
          .groupBy('agent_id')
          .execute(),
        db()
          .selectFrom('llm_calls')
          .select(({ fn }) => [
            'agent_id',
            fn.sum<string>('input_tokens').as('input_tokens'),
            fn.sum<string>('output_tokens').as('output_tokens'),
          ])
          .where('agent_id', 'in', agentIds)
          .where('created_at', '>=', since)
          .groupBy('agent_id')
          .execute(),
      ]);
      const calls = new Map(callRows.map((row) => [row.agent_id, row]));
      const tokens = new Map(tokenRows.map((row) => [row.agent_id, row]));
      return agents.map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        calls: Number(calls.get(agent.id)?.calls ?? 0),
        errors: Number(calls.get(agent.id)?.errors ?? 0),
        inputTokens: Number(tokens.get(agent.id)?.input_tokens ?? 0),
        outputTokens: Number(tokens.get(agent.id)?.output_tokens ?? 0),
      }));
    },
    async tokenTrend(agentIds, days, timeZone) {
      if (agentIds.length === 0) return [];
      // Grouped by the alias `day`, never a repeat of the expression: each
      // `${timeZone}` is its own bound parameter, and a repeat is a
      // different expression to Postgres.
      const rows = await db()
        .selectFrom('llm_calls')
        .select(({ fn }) => [
          sql<string>`to_char(created_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`.as('day'),
          fn.sum<string>('input_tokens').as('input_tokens'),
          fn.sum<string>('output_tokens').as('output_tokens'),
        ])
        .where('agent_id', 'in', [...agentIds])
        .where(
          'created_at',
          '>=',
          sql<Date>`((date_trunc('day', NOW() AT TIME ZONE ${timeZone}) - MAKE_INTERVAL(days => ${Math.max(0, days - 1)})) AT TIME ZONE ${timeZone})`
        )
        .groupBy(sql`day`)
        .orderBy(sql`day`, 'asc')
        .execute();
      return rows.map((row) => ({
        day: row.day,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
      }));
    },
    async tokensByRun(runIds) {
      if (runIds.length === 0) return [];
      const rows = await db()
        .selectFrom('llm_calls')
        .select(({ fn }) => [
          'run_id',
          fn.sum<string>('input_tokens').as('input_tokens'),
          fn.sum<string>('output_tokens').as('output_tokens'),
          fn.coalesce(fn.sum<string>('cache_read_input_tokens'), sql<string>`0`).as('cache_read'),
          fn.coalesce(fn.sum<string>('cache_write_input_tokens'), sql<string>`0`).as('cache_write'),
          fn.countAll<string>().as('calls'),
        ])
        .where('run_id', 'in', [...runIds])
        .groupBy('run_id')
        .orderBy('run_id')
        .execute();
      return rows.flatMap((row) =>
        row.run_id ? [{ runId: row.run_id, totals: totalsOf(row) }] : []
      );
    },
    async runTokensByModel(runId) {
      const rows = await db()
        .selectFrom('llm_calls')
        .select(({ fn }) => [
          'provider',
          'model',
          fn.sum<string>('input_tokens').as('input_tokens'),
          fn.sum<string>('output_tokens').as('output_tokens'),
          fn.coalesce(fn.sum<string>('cache_read_input_tokens'), sql<string>`0`).as('cache_read'),
          fn.coalesce(fn.sum<string>('cache_write_input_tokens'), sql<string>`0`).as('cache_write'),
          fn.countAll<string>().as('calls'),
        ])
        .where('run_id', '=', runId)
        .groupBy(['provider', 'model'])
        .orderBy(sql`SUM(input_tokens) + SUM(output_tokens)`, 'desc')
        .orderBy('provider')
        .orderBy('model')
        .execute();
      return rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        totals: totalsOf(row),
      }));
    },
    async invocationCounts(agentId) {
      const [agent, org] = await Promise.all([
        sql<RunLogRow>`
          SELECT ${RUN_LOG_BUCKET_COLUMNS()}
          FROM agent_run_log
          WHERE agent_id = ${agentId}
        `.execute(db()),
        sql<{ total: string }>`
          SELECT COUNT(*) AS total
          FROM agent_run_log
          WHERE created_at::date = CURRENT_DATE
        `.execute(db()),
      ]);
      return { agent: runLogOf(agent.rows[0]), orgToday: Number(org.rows[0]?.total ?? 0) };
    },
    async runLogBuckets() {
      const [totals, perAgent] = await Promise.all([
        sql<RunLogRow>`
          SELECT ${RUN_LOG_BUCKET_COLUMNS()}
          FROM agent_run_log
        `.execute(db()),
        sql<RunLogRow & { agent_id: string }>`
          SELECT agent_id, ${RUN_LOG_BUCKET_COLUMNS()}
          FROM agent_run_log
          GROUP BY agent_id
          ORDER BY agent_id
        `.execute(db()),
      ]);
      return {
        totals: runLogOf(totals.rows[0]),
        byAgent: perAgent.rows.map((row) => ({ agentId: row.agent_id, buckets: runLogOf(row) })),
      };
    },
  };
}
