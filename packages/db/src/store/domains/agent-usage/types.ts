/**
 * Calendar buckets: today, yesterday, this week (from Monday), month,
 * quarter, year, and all time. Cut on the database session's calendar
 * (CURRENT_DATE) by Postgres; the memory store cuts on UTC, which is what
 * the session calendar is wherever the server runs in UTC (the contract
 * database included).
 */
export interface UsageBucketsRecord {
  today: number;
  yesterday: number;
  week: number;
  month: number;
  quarter: number;
  year: number;
  allTime: number;
}

/** Ledger tokens (llm_calls) in calendar buckets, per token kind. */
export interface TokenBucketsRecord {
  input: UsageBucketsRecord;
  output: UsageBucketsRecord;
  cacheRead: UsageBucketsRecord;
  cacheWrite: UsageBucketsRecord;
}

export interface ModelTokenBucketsRecord extends TokenBucketsRecord {
  provider: string | null;
  model: string | null;
}

export interface ToolUsageRecord {
  tool: string;
  calls: number;
  /** Calls whose status is not 'ok'. */
  errors: number;
  /** percentile_disc(0.5) and (0.95) of duration_ms. */
  medianMs: number;
  p95Ms: number;
}

export interface AgentUsageSummaryRecord {
  agentId: string;
  name: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RunTokenTotalsRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Ledger rows (model turns). */
  calls: number;
}

/** Run-log tallies in calendar buckets: every run, and failed ones. */
export interface RunLogBucketsRecord {
  runs: UsageBucketsRecord;
  failures: UsageBucketsRecord;
}

export interface AgentUsageStore {
  /**
   * Token buckets summed over these agents' ledger rows, or over every
   * row in the deployment (chat and optimizer spend included) for null.
   * An empty list reads as zero.
   */
  tokenBuckets(agentIds: readonly string[] | null): Promise<TokenBucketsRecord>;
  /** Token buckets per agent, for every agent with ledger rows, by agent id. */
  tokenBucketsByAgent(): Promise<{ agentId: string; usage: TokenBucketsRecord }[]>;
  /**
   * Token buckets per (provider, model), over these agents or (null)
   * every row; largest input+output first, ties by provider then model
   * (nulls last).
   */
  tokenBucketsByModel(agentIds: readonly string[] | null): Promise<ModelTokenBucketsRecord[]>;
  /**
   * Tool calls these agents made since `days` ago, per tool; most calls
   * first, ties by tool.
   */
  toolUsage(agentIds: readonly string[], days: number): Promise<ToolUsageRecord[]>;
  /**
   * Calls and tokens since `days` ago, per agent of this owner (null:
   * every agent), in agent-name order (ties by id); agents without usage
   * read as zero.
   */
  usageSummaries(ownerSubject: string | null, days: number): Promise<AgentUsageSummaryRecord[]>;
  /**
   * Daily input/output tokens of these agents, the day being the calendar
   * date in `timeZone`, from `days - 1` days before today there; by day.
   */
  tokenTrend(
    agentIds: readonly string[],
    days: number,
    timeZone: string
  ): Promise<{ day: string; inputTokens: number; outputTokens: number }[]>;
  /** Token totals per run, for the runs that have ledger rows, by run id. */
  tokensByRun(
    runIds: readonly string[]
  ): Promise<{ runId: string; totals: RunTokenTotalsRecord }[]>;
  /** One run's totals per (provider, model); largest input+output first, ties as above. */
  runTokensByModel(
    runId: string
  ): Promise<{ provider: string | null; model: string | null; totals: RunTokenTotalsRecord }[]>;
  /** One agent's run-log tallies, and every agent's runs started today. */
  invocationCounts(agentId: string): Promise<{ agent: RunLogBucketsRecord; orgToday: number }>;
  /** Run-log tallies over the deployment, and per agent (by agent id). */
  runLogBuckets(): Promise<{
    totals: RunLogBucketsRecord;
    byAgent: { agentId: string; buckets: RunLogBucketsRecord }[];
  }>;
}
