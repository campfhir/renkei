/**
 * Per-agent usage: token spend, run tallies and tool calls, read from the
 * timestamped ledgers — `llm_calls` (081) for tokens and `tool_calls`
 * (032, agent-stamped by 082) for calls.
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
  week: number;
  month: number;
  quarter: number;
  year: number;
  allTime: number;
}

interface TokenBucketRow {
  in_today: string;
  in_week: string;
  in_month: string;
  in_quarter: string;
  in_year: string;
  in_all_time: string;
  out_today: string;
  out_week: string;
  out_month: string;
  out_quarter: string;
  out_year: string;
  out_all_time: string;
}

/** One agent, or several summed together — the person page passes its whole roster. */
function idsOf(agentId: string | readonly string[]): string[] {
  return typeof agentId === 'string' ? [agentId] : [...agentId];
}

const ZERO_BUCKETS: UsageBuckets = { today: 0, week: 0, month: 0, quarter: 0, year: 0, allTime: 0 };

/**
 * Token buckets for one agent (or a set of them, summed), calendar-shaped
 * like the run buckets on the oversight page — the point of a ledger that
 * outlives run retention is reading "this quarter" without caring where
 * retention's cutoff currently sits.
 */
export async function getAgentTokenUsage(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string | readonly string[]
): Promise<{ input: UsageBuckets; output: UsageBuckets }> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return { input: ZERO_BUCKETS, output: ZERO_BUCKETS };
  const result = await sql<TokenBucketRow>`
    SELECT
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS in_today,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS in_week,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS in_month,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS in_quarter,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS in_year,
      COALESCE(SUM(input_tokens), 0) AS in_all_time,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS out_today,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS out_week,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS out_month,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS out_quarter,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS out_year,
      COALESCE(SUM(output_tokens), 0) AS out_all_time
    FROM llm_calls
    WHERE tenant_id = ${tenantId} AND agent_id IN (${sql.join(ids)})
  `.execute(db);
  const row = result.rows[0];
  return {
    input: {
      today: Number(row?.in_today ?? 0),
      week: Number(row?.in_week ?? 0),
      month: Number(row?.in_month ?? 0),
      quarter: Number(row?.in_quarter ?? 0),
      year: Number(row?.in_year ?? 0),
      allTime: Number(row?.in_all_time ?? 0),
    },
    output: {
      today: Number(row?.out_today ?? 0),
      week: Number(row?.out_week ?? 0),
      month: Number(row?.out_month ?? 0),
      quarter: Number(row?.out_quarter ?? 0),
      year: Number(row?.out_year ?? 0),
      allTime: Number(row?.out_all_time ?? 0),
    },
  };
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
 * call an agent run makes with the agent's id (082). Free in-process calls
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
