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
 * because its chart is refetched from the browser. The numbers come from
 * the data store's agentUsage domain; this file shapes them.
 */

import { getDataStore, type RunLogBucketsRecord } from '@renkei/db';
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

/** No spend in any bucket — what an agent with no ledger rows reads as. */
export const ZERO_TOKEN_USAGE: TokenUsage = {
  input: ZERO_BUCKETS,
  output: ZERO_BUCKETS,
  cacheRead: ZERO_BUCKETS,
  cacheWrite: ZERO_BUCKETS,
};

export async function getAgentTokenUsage(agentId: string | readonly string[]): Promise<TokenUsage> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return ZERO_TOKEN_USAGE;
  return getDataStore().agentUsage.tokenBuckets(ids);
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
  agentId: string | readonly string[],
  days = 30
): Promise<AgentToolUsageRow[]> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return [];
  const rows = await getDataStore().agentUsage.toolUsage(ids, days);
  return rows.map((row) => ({ ...row, connector: connectorKeyForTool(row.tool) }));
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
  ownerSubject: string | null,
  days: number
): Promise<AgentUsageSummary[]> {
  const rows = await getDataStore().agentUsage.usageSummaries(ownerSubject, days);
  return [...rows].sort(
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
 * chart's per-agent breakdown filters down to a single id. Bucketed in
 * `timeZone` — the viewer's, since the chart refetches from the browser.
 */
export async function getAgentTokenTrend(
  agentId: string | readonly string[],
  days: number,
  timeZone: string
): Promise<DailyTokenPoint[]> {
  const ids = idsOf(agentId);
  if (ids.length === 0) return [];
  return getDataStore().agentUsage.tokenTrend(ids, days, timeZone);
}

/** Every ledger row in the org — runs, optimizer passes and chat alike. */
export async function getTenantTokenUsage(): Promise<TokenUsage> {
  return getDataStore().agentUsage.tokenBuckets(null);
}

/**
 * Token buckets for every agent in the org at once, keyed by agent id —
 * the oversight page's per-card numbers in one query. Every purpose
 * stamped with the agent counts (its runs and the optimizer's passes over
 * it), matching the agent's own page; chat spend has no agent and only
 * reaches the org total.
 */
export async function getTokenUsageByAgent(): Promise<Record<string, TokenUsage>> {
  const rows = await getDataStore().agentUsage.tokenBucketsByAgent();
  return Object.fromEntries(rows.map((row) => [row.agentId, row.usage]));
}

export interface ModelTokenUsage extends TokenUsage {
  /** Null on rows written before the ledger recorded the model (098). */
  provider: string | null;
  model: string | null;
}

/**
 * Token buckets split by the model they were spent on (098) — the
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
  agentId: string | readonly string[] | null
): Promise<ModelTokenUsage[]> {
  const ids = agentId === null ? null : idsOf(agentId);
  if (ids !== null && ids.length === 0) return [];
  return getDataStore().agentUsage.tokenBucketsByModel(ids);
}

/**
 * One run's tokens: plain totals, no calendar buckets — a run is a point
 * in time, so "this week" is a question about the agent, not the run.
 */
export interface RunTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Model turns — one ledger row each. */
  calls: number;
}

export const ZERO_RUN_TOTALS: RunTokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 0,
};

/**
 * Token totals for a set of runs at once, keyed by run id — the per-run
 * figure beside each line of a run listing, in one query. A run with no
 * ledger rows (queued, or one that never reached the model) is simply
 * absent. Content-free like everything here: the ledger holds counts and
 * ids only, so a grantee reads the same numbers as the owner.
 */
export async function getTokenUsageByRun(
  runIds: readonly string[]
): Promise<Record<string, RunTokenTotals>> {
  if (runIds.length === 0) return {};
  const rows = await getDataStore().agentUsage.tokensByRun(runIds);
  return Object.fromEntries(rows.map((row) => [row.runId, row.totals]));
}

export interface RunModelTokenUsage extends RunTokenTotals {
  provider: string | null;
  model: string | null;
}

/** One run's token spend per model, ordered by spend. */
export async function getRunTokenUsage(runId: string): Promise<RunModelTokenUsage[]> {
  const rows = await getDataStore().agentUsage.runTokensByModel(runId);
  return rows.map((row) => ({ provider: row.provider, model: row.model, ...row.totals }));
}

/** The grouped rows summed back into one figure — pure, so the tools' text is unit-testable. */
export function sumRunTotals(rows: readonly RunTokenTotals[]): RunTokenTotals {
  return rows.reduce(
    (sum, row) => ({
      input: sum.input + row.input,
      output: sum.output + row.output,
      cacheRead: sum.cacheRead + row.cacheRead,
      cacheWrite: sum.cacheWrite + row.cacheWrite,
      calls: sum.calls + row.calls,
    }),
    ZERO_RUN_TOTALS
  );
}

/** Run counts and failures in calendar buckets, from the durable run log (083). */
export interface RunTallies {
  runs: UsageBuckets;
  failures: UsageBuckets;
}

function talliesOf(record: RunLogBucketsRecord): RunTallies {
  return { runs: record.runs, failures: record.failures };
}

/**
 * Run tallies for one agent from the durable run log, which survives the
 * run-retention prune — that survival is what makes the quarterly/yearly/
 * all-time numbers real — plus the runs started org-wide today, for
 * reading against the daily cap.
 */
export async function getAgentInvocationCounts(
  agentId: string
): Promise<{ agent: RunTallies; orgToday: number }> {
  const counts = await getDataStore().agentUsage.invocationCounts(agentId);
  return { agent: talliesOf(counts.agent), orgToday: counts.orgToday };
}

/** Run tallies over the whole org and per agent (keyed by agent id) — the oversight page. */
export async function getRunTallies(): Promise<{
  totals: RunTallies;
  byAgent: Record<string, RunTallies>;
}> {
  const buckets = await getDataStore().agentUsage.runLogBuckets();
  return {
    totals: talliesOf(buckets.totals),
    byAgent: Object.fromEntries(
      buckets.byAgent.map((row) => [row.agentId, talliesOf(row.buckets)])
    ),
  };
}
