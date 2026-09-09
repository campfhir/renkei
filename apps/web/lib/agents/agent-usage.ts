/**
 * Per-agent usage: token spend, run tallies and tool calls, read from the
 * timestamped ledgers — `llm_calls` (085) for tokens and `tool_calls`
 * (032, agent-stamped by 086) for calls.
 *
 * Both are content-free by construction, so the owner and an admin get
 * the SAME numbers: there is no per-audience redaction here any more,
 * because nothing here can leak. (The earlier version read tool calls out
 * of `agent_run_steps.detail`, which is content, and so had to show an
 * admin only failed attempts' calls.) Both ledgers outlive run retention
 * under the org's `agentUsageRetentionDays`, so a year-long window is
 * safe to ask for.
 *
 * Calendar buckets (today / this week / …) are cut on the database
 * session's calendar (CURRENT_DATE), which is what these server-rendered
 * panels have always shown; the trend series takes the viewer's zone,
 * because its chart is refetched from the browser.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { connectorKeyForTool } from '@renkei/tool-outcomes';

export interface UsageBuckets {
  today: number;
  yesterday: number;
  week: number;
  month: number;
  quarter: number;
  year: number;
  allTime: number;
}

/** One grouped ledger row: six calendar buckets per token kind, by prefix. */
interface TokenBucketRow {
  in_today: string;
  in_yesterday: string;
  in_week: string;
  in_month: string;
  in_quarter: string;
  in_year: string;
  in_all_time: string;
  out_today: string;
  out_yesterday: string;
  out_week: string;
  out_month: string;
  out_quarter: string;
  out_year: string;
  out_all_time: string;
  cr_today: string;
  cr_yesterday: string;
  cr_week: string;
  cr_month: string;
  cr_quarter: string;
  cr_year: string;
  cr_all_time: string;
  cw_today: string;
  cw_yesterday: string;
  cw_week: string;
  cw_month: string;
  cw_quarter: string;
  cw_year: string;
  cw_all_time: string;
}

/** One agent, or several summed together — the person page passes its whole roster. */
function idsOf(agentId: string | readonly string[]): string[] {
  return typeof agentId === 'string' ? [agentId] : [...agentId];
}

const ZERO_BUCKETS: UsageBuckets = {
  today: 0,
  yesterday: 0,
  week: 0,
  month: 0,
  quarter: 0,
  year: 0,
  allTime: 0,
};

/** The same six calendar buckets, per column prefix, off one grouped row. */
function bucketsOf(row: TokenBucketRow, prefix: 'in' | 'out' | 'cr' | 'cw'): UsageBuckets {
  return {
    today: Number(row[`${prefix}_today`] ?? 0),
    yesterday: Number(row[`${prefix}_yesterday`] ?? 0),
    week: Number(row[`${prefix}_week`] ?? 0),
    month: Number(row[`${prefix}_month`] ?? 0),
    quarter: Number(row[`${prefix}_quarter`] ?? 0),
    year: Number(row[`${prefix}_year`] ?? 0),
    allTime: Number(row[`${prefix}_all_time`] ?? 0),
  };
}

const TOKEN_BUCKET_COLUMNS = sql`
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS in_today,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE - 1), 0) AS in_yesterday,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS in_week,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS in_month,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS in_quarter,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS in_year,
  COALESCE(SUM(input_tokens), 0) AS in_all_time,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS out_today,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date = CURRENT_DATE - 1), 0) AS out_yesterday,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS out_week,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS out_month,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS out_quarter,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS out_year,
  COALESCE(SUM(output_tokens), 0) AS out_all_time,
  COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS cr_today,
  COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE - 1), 0) AS cr_yesterday,
  COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS cr_week,
  COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS cr_month,
  COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS cr_quarter,
  COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS cr_year,
  COALESCE(SUM(cache_read_input_tokens), 0) AS cr_all_time,
  COALESCE(SUM(cache_write_input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS cw_today,
  COALESCE(SUM(cache_write_input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE - 1), 0) AS cw_yesterday,
  COALESCE(SUM(cache_write_input_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS cw_week,
  COALESCE(SUM(cache_write_input_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS cw_month,
  COALESCE(SUM(cache_write_input_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS cw_quarter,
  COALESCE(SUM(cache_write_input_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS cw_year,
  COALESCE(SUM(cache_write_input_tokens), 0) AS cw_all_time
`;

/**
 * Token buckets for one agent (or a set of them, summed), calendar-shaped
 * like the run buckets on the oversight page — the point of a ledger that
 * outlives run retention is reading "this quarter" without caring where
 * retention's cutoff currently sits.
 */
export interface TokenUsage {
  /** Uncached prompt tokens. */
  input: UsageBuckets;
  output: UsageBuckets;
  /** Prompt tokens served from the provider's cache — additive to `input` (097). */
  cacheRead: UsageBuckets;
  /** Prompt tokens written to the cache. */
  cacheWrite: UsageBuckets;
}

function usageOf(row: TokenBucketRow | undefined): TokenUsage {
  if (!row) {
    return {
      input: ZERO_BUCKETS,
      output: ZERO_BUCKETS,
      cacheRead: ZERO_BUCKETS,
      cacheWrite: ZERO_BUCKETS,
    };
  }
  return {
    input: bucketsOf(row, 'in'),
    output: bucketsOf(row, 'out'),
    cacheRead: bucketsOf(row, 'cr'),
    cacheWrite: bucketsOf(row, 'cw'),
  };
}

export async function getAgentTokenUsage(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string | readonly string[]
): Promise<TokenUsage> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return usageOf(undefined);
  const result = await sql<TokenBucketRow>`
    SELECT ${TOKEN_BUCKET_COLUMNS}
    FROM llm_calls
    WHERE tenant_id = ${tenantId} AND agent_id IN (${sql.join(ids)})
  `.execute(db);
  return usageOf(result.rows[0]);
}

export interface AgentToolUsageRow {
  tool: string;
  connector: string | null;
  calls: number;
  errors: number;
  /** Median and tail latency, in ms — the same pair the tools page shows. */
  medianMs: number;
  p95Ms: number;
}

/**
 * Tool calls this agent (or a set of them, summed) made over `days`,
 * grouped by tool — from `tool_calls`, where the MCP gateway records every
 * call an agent run makes with the agent's id (086). Free in-process calls
 * (resolve_time, finish_step, ask_person) never reach the gateway and so
 * are never counted, matching what `tool_call_count` already excludes.
 * Complete for every audience: the ledger holds names and timings only.
 */
export async function getAgentToolUsage(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string | readonly string[],
  days = 30
): Promise<AgentToolUsageRow[]> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('tool_calls')
    .select([
      'tool',
      sql<string>`count(*)`.as('calls'),
      sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      sql<string>`percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)`.as('median_ms'),
      sql<string>`percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)`.as('p95_ms'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', 'in', ids)
    .where('started_at', '>=', sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`)
    .groupBy('tool')
    .orderBy(sql`count(*)`, 'desc')
    .execute();

  return rows.map((row) => ({
    tool: row.tool,
    connector: connectorKeyForTool(row.tool),
    calls: Number(row.calls),
    errors: Number(row.errors),
    medianMs: Number(row.median_ms ?? 0),
    p95Ms: Number(row.p95_ms ?? 0),
  }));
}

export interface AgentUsageSummary {
  agentId: string;
  name: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Usage rolled up per agent, for the org-wide tools page's "by agent"
 * section — the same window that page's period toggle already drives.
 *
 * `ownerSubject: null` means every agent in the tenant (an operator looking
 * tenant-wide); otherwise just that owner's own agents. Null is the only
 * way to widen, so a forgotten argument narrows rather than leaks.
 */
export async function getAgentUsageSummaries(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string | null,
  days: number
): Promise<AgentUsageSummary[]> {
  let agentQuery = db.selectFrom('agents').select(['id', 'name']).where('tenant_id', '=', tenantId);
  if (ownerSubject !== null) agentQuery = agentQuery.where('owner_subject', '=', ownerSubject);
  const agents = await agentQuery.orderBy('name').execute();
  if (agents.length === 0) return [];
  const agentIds = agents.map((agent) => agent.id);
  const since = sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`;

  const [callRows, tokenRows] = await Promise.all([
    db
      .selectFrom('tool_calls')
      .select([
        'agent_id',
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('agent_id', 'in', agentIds)
      .where('started_at', '>=', since)
      .groupBy('agent_id')
      .execute(),
    db
      .selectFrom('llm_calls')
      .select(({ fn }) => [
        'agent_id',
        fn.sum<string>('input_tokens').as('input_tokens'),
        fn.sum<string>('output_tokens').as('output_tokens'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('agent_id', 'in', agentIds)
      .where('created_at', '>=', since)
      .groupBy('agent_id')
      .execute(),
  ]);

  const callsByAgent = new Map(callRows.map((row) => [row.agent_id, row]));
  const tokensByAgent = new Map(tokenRows.map((row) => [row.agent_id, row]));

  return agents
    .map((agent) => {
      const call = callsByAgent.get(agent.id);
      const tokens = tokensByAgent.get(agent.id);
      return {
        agentId: agent.id,
        name: agent.name,
        calls: Number(call?.calls ?? 0),
        errors: Number(call?.errors ?? 0),
        inputTokens: Number(tokens?.input_tokens ?? 0),
        outputTokens: Number(tokens?.output_tokens ?? 0),
      };
    })
    .sort(
      (left, right) =>
        right.calls - left.calls ||
        right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens)
    );
}

export interface DailyTokenPoint {
  /** Calendar date, YYYY-MM-DD, in the zone the series was asked for. */
  day: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Daily token spend for one agent, or several summed — the raw series the
 * person page's trend chart buckets into day/week/month, and the input the
 * chart's per-agent breakdown filters down to a single id.
 *
 * Bucketed in `timeZone` — the viewer's, since the chart refetches from
 * the browser. Grouped by the alias `day`, never a repeat of the
 * expression: each `${timeZone}` is its own bound parameter, and a repeat
 * is a different expression to Postgres.
 */
export async function getAgentTokenTrend(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string | readonly string[],
  days: number,
  timeZone: string
): Promise<DailyTokenPoint[]> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('llm_calls')
    .select(({ fn }) => [
      sql<string>`to_char(created_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`.as('day'),
      fn.sum<string>('input_tokens').as('input_tokens'),
      fn.sum<string>('output_tokens').as('output_tokens'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', 'in', ids)
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
}

/** Every ledger row in the org — runs, optimizer passes and chat alike. */
export async function getTenantTokenUsage(db: Kysely<DB>, tenantId: string): Promise<TokenUsage> {
  const result = await sql<TokenBucketRow>`
    SELECT ${TOKEN_BUCKET_COLUMNS}
    FROM llm_calls
    WHERE tenant_id = ${tenantId}
  `.execute(db);
  return usageOf(result.rows[0]);
}

/**
 * Token buckets for every agent in the org at once, keyed by agent id —
 * the oversight page's per-card numbers in one query. Every purpose
 * stamped with the agent counts (its runs and the optimizer's passes over
 * it), matching the agent's own page; chat spend has no agent and only
 * reaches the org total.
 */
export async function getTokenUsageByAgent(
  db: Kysely<DB>,
  tenantId: string
): Promise<Record<string, TokenUsage>> {
  const result = await sql<TokenBucketRow & { agent_id: string }>`
    SELECT agent_id, ${TOKEN_BUCKET_COLUMNS}
    FROM llm_calls
    WHERE tenant_id = ${tenantId} AND agent_id IS NOT NULL
    GROUP BY agent_id
  `.execute(db);
  return Object.fromEntries(result.rows.map((row) => [row.agent_id, usageOf(row)]));
}

export interface ModelTokenUsage extends TokenUsage {
  /** Null on rows written before the ledger recorded the model (096). */
  provider: string | null;
  model: string | null;
}

interface ModelBucketRow extends TokenBucketRow {
  provider: string | null;
  model: string | null;
}

/**
 * Token buckets split by the model they were spent on (096) — the
 * breakdown that makes a token count mean something as a cost, since a
 * million tokens on a frontier model and a million on a small one are
 * not the same bill.
 *
 * `agentId: null` means every row in the tenant, including chat and
 * optimizer spend with no agent — the oversight page's org-wide view;
 * an id (or a set) narrows to those agents. Null is the only way to
 * widen. Ordered by total spend, largest first; rows written before the
 * model was recorded surface as one null-model row.
 */
export async function getTokenUsageByModel(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string | readonly string[] | null
): Promise<ModelTokenUsage[]> {
  const ids = agentId === null ? null : idsOf(agentId);
  if (ids !== null && ids.length === 0) return [];
  const result = await sql<ModelBucketRow>`
    SELECT provider, model, ${TOKEN_BUCKET_COLUMNS}
    FROM llm_calls
    WHERE tenant_id = ${tenantId}
      ${ids === null ? sql`` : sql`AND agent_id IN (${sql.join(ids)})`}
    GROUP BY provider, model
    ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC
  `.execute(db);
  return result.rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    ...usageOf(row),
  }));
}

export interface StepTokenUsage extends TokenUsage {
  /** Null for spend outside any step — the optimizer's passes. */
  stepId: string | null;
  /**
   * The step's current name from the agent's definition, or null when
   * the id no longer exists there (a step since removed) — see
   * `labelStepUsage`.
   */
  stepName: string | null;
  /** The step's 1-based position in the definition's pre-order walk, or null with the name. */
  stepNumber: number | null;
  provider: string | null;
  model: string | null;
  /** Attempts that reached the model — one ledger row each. */
  calls: UsageBuckets;
}

interface StepBucketRow extends ModelBucketRow {
  step_id: string | null;
  calls_today: string;
  calls_yesterday: string;
  calls_week: string;
  calls_month: string;
  calls_quarter: string;
  calls_year: string;
  calls_all_time: string;
}

/**
 * One agent's token spend per step and model — the drill-down under the
 * per-agent total, so the step that costs the most can be found without
 * opening its runs one by one. Grouped on `step_id`, which the engine
 * stamps on every attempt's ledger row; names are resolved afterwards
 * against the agent's CURRENT definition by `labelStepUsage`, so a step
 * renamed since keeps its history under its new name and a removed one
 * is still listed, unnamed.
 *
 * Content-free like the rest of this module: step ids and names come
 * from the definition, which the viewer can already see.
 */
export async function getAgentTokenUsageByStep(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<Omit<StepTokenUsage, 'stepName' | 'stepNumber'>[]> {
  const result = await sql<StepBucketRow>`
    SELECT step_id, provider, model, ${TOKEN_BUCKET_COLUMNS},
      COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS calls_today,
      COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE - 1) AS calls_yesterday,
      COUNT(*) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)) AS calls_week,
      COUNT(*) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)) AS calls_month,
      COUNT(*) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)) AS calls_quarter,
      COUNT(*) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)) AS calls_year,
      COUNT(*) AS calls_all_time
    FROM llm_calls
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
    GROUP BY step_id, provider, model
    ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC
  `.execute(db);
  return result.rows.map((row) => ({
    stepId: row.step_id,
    provider: row.provider,
    model: row.model,
    calls: {
      today: Number(row.calls_today ?? 0),
      yesterday: Number(row.calls_yesterday ?? 0),
      week: Number(row.calls_week ?? 0),
      month: Number(row.calls_month ?? 0),
      quarter: Number(row.calls_quarter ?? 0),
      year: Number(row.calls_year ?? 0),
      allTime: Number(row.calls_all_time ?? 0),
    },
    ...usageOf(row),
  }));
}
