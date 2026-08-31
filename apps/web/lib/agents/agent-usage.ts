/**
 * Per-agent usage: token spend and tool calls by connector.
 *
 * Token totals come from the durable `agent_run_counters` rollup (migration
 * 072) — content-free, so both the owner and an admin get the exact same
 * numbers, and they survive the run-retention prune the way the oversight
 * page's run/failure buckets already do.
 *
 * Tool-call counts are different: they are read straight out of
 * `agent_run_steps.detail.toolCalls`, which is CONTENT and obeys the same
 * visibility rule `runs-view.ts` applies everywhere else — an owner sees
 * every attempt's tool calls, an admin only a FAILED attempt's. That makes
 * this breakdown, unlike the token totals, bounded by retention and (for an
 * admin) partial by construction — the same tradeoff the run pages already
 * make, not a new one.
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
 * like the run/failure buckets on the oversight page — the point of a
 * rollup like this is reading "this quarter" without caring where
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
      COALESCE(SUM(input_tokens) FILTER (WHERE day = CURRENT_DATE), 0) AS in_today,
      COALESCE(SUM(input_tokens) FILTER (WHERE day >= date_trunc('week', CURRENT_DATE)), 0) AS in_week,
      COALESCE(SUM(input_tokens) FILTER (WHERE day >= date_trunc('month', CURRENT_DATE)), 0) AS in_month,
      COALESCE(SUM(input_tokens) FILTER (WHERE day >= date_trunc('quarter', CURRENT_DATE)), 0) AS in_quarter,
      COALESCE(SUM(input_tokens) FILTER (WHERE day >= date_trunc('year', CURRENT_DATE)), 0) AS in_year,
      COALESCE(SUM(input_tokens), 0) AS in_all_time,
      COALESCE(SUM(output_tokens) FILTER (WHERE day = CURRENT_DATE), 0) AS out_today,
      COALESCE(SUM(output_tokens) FILTER (WHERE day >= date_trunc('week', CURRENT_DATE)), 0) AS out_week,
      COALESCE(SUM(output_tokens) FILTER (WHERE day >= date_trunc('month', CURRENT_DATE)), 0) AS out_month,
      COALESCE(SUM(output_tokens) FILTER (WHERE day >= date_trunc('quarter', CURRENT_DATE)), 0) AS out_quarter,
      COALESCE(SUM(output_tokens) FILTER (WHERE day >= date_trunc('year', CURRENT_DATE)), 0) AS out_year,
      COALESCE(SUM(output_tokens), 0) AS out_all_time
    FROM agent_run_counters
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
 * Tool calls this agent (or a set of them, summed) made, grouped by tool —
 * over `days` (bounded by retention, since it reads live run rows). `free`
 * in-process calls (resolve_time, finish_step, ask_person) are excluded,
 * matching what `tool_call_count` already excludes.
 *
 * `audience: 'admin'` applies the SAME redaction runDetail does: only
 * FAILED attempts' tool calls are visible, so an admin's breakdown is
 * partial by construction, not a bug — the owner's is complete.
 */
export async function getAgentToolUsage(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string | readonly string[],
  audience: 'owner' | 'admin',
  days = 30
): Promise<AgentToolUsageRow[]> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return [];
  const visibility = audience === 'admin' ? sql`AND s.status = 'failed'` : sql``;
  const rows = await sql<{
    tool: string;
    calls: string;
    errors: string;
    median_ms: string | null;
    p95_ms: string | null;
  }>`
    SELECT
      elem->>'tool' AS tool,
      COUNT(*) AS calls,
      COUNT(*) FILTER (WHERE (elem->>'isError')::boolean) AS errors,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY (elem->>'durationMs')::numeric) AS median_ms,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY (elem->>'durationMs')::numeric) AS p95_ms
    FROM agent_run_steps s
    JOIN agent_runs r ON r.id = s.run_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.detail->'toolCalls', '[]'::jsonb)) AS elem
    WHERE s.tenant_id = ${tenantId}
      AND r.tenant_id = ${tenantId}
      AND r.agent_id IN (${sql.join(ids)})
      AND r.created_at >= NOW() - MAKE_INTERVAL(days => ${days})
      AND COALESCE((elem->>'free')::boolean, false) = false
      ${visibility}
    GROUP BY tool
    ORDER BY calls DESC
  `.execute(db);

  return rows.rows.map((row) => ({
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
 * tenant-wide); otherwise just that owner's own agents. It is the same
 * distinction `getAgentToolUsage`'s audience makes, applied across many
 * agents at once instead of one: tenant-wide, tool calls are counted only
 * on FAILED attempts (content an admin may see); an owner's own agents
 * count every attempt, because it is all their own content.
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

  const visibility = ownerSubject === null ? sql`AND s.status = 'failed'` : sql``;
  const callRows = await sql<{ agent_id: string; calls: string; errors: string }>`
    SELECT
      r.agent_id,
      COUNT(*) AS calls,
      COUNT(*) FILTER (WHERE (elem->>'isError')::boolean) AS errors
    FROM agent_run_steps s
    JOIN agent_runs r ON r.id = s.run_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.detail->'toolCalls', '[]'::jsonb)) AS elem
    WHERE s.tenant_id = ${tenantId}
      AND r.tenant_id = ${tenantId}
      AND r.agent_id IN (${sql.join(agentIds)})
      AND r.created_at >= NOW() - MAKE_INTERVAL(days => ${days})
      AND COALESCE((elem->>'free')::boolean, false) = false
      ${visibility}
    GROUP BY r.agent_id
  `.execute(db);

  const tokenRows = await db
    .selectFrom('agent_run_counters')
    .select([
      'agent_id',
      (eb) => eb.fn.sum<string>('input_tokens').as('input_tokens'),
      (eb) => eb.fn.sum<string>('output_tokens').as('output_tokens'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', 'in', agentIds)
    .where('day', '>=', sql<Date>`(NOW() - MAKE_INTERVAL(days => ${days}))::date`)
    .groupBy('agent_id')
    .execute();

  const callsByAgent = new Map(callRows.rows.map((row) => [row.agent_id, row]));
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
  /** Calendar date, YYYY-MM-DD — the same shape agent_run_counters.day is stored in. */
  day: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Daily token spend for one agent, or several summed — the raw series the
 * person page's trend chart buckets into day/week/month, and the input the
 * chart's per-agent breakdown filters down to a single id.
 *
 * Reads `agent_run_counters` (durable, content-free), so a year-long window
 * is safe to ask for — unlike `getAgentToolUsage`, which reads live run rows
 * bounded by retention.
 */
export async function getAgentTokenTrend(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string | readonly string[],
  days: number
): Promise<DailyTokenPoint[]> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('agent_run_counters')
    .select([
      sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'),
      (eb) => eb.fn.sum<string>('input_tokens').as('input_tokens'),
      (eb) => eb.fn.sum<string>('output_tokens').as('output_tokens'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', 'in', ids)
    .where(
      'day',
      '>=',
      sql<Date>`(CURRENT_DATE - MAKE_INTERVAL(days => ${Math.max(0, days - 1)}))::date`
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
