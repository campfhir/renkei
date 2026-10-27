/**
 * A half-open range of instants: `since` inclusive, `until` exclusive, or
 * open-ended when `until` is null/absent. The caller works out the
 * instants (the viewer's local midnights); the store only compares.
 */
export interface ToolUsageWindow {
  since: Date;
  until?: Date | null;
}

/**
 * A row's bucket: its local calendar day (`YYYY-MM-DD`) or hour
 * (`YYYY-MM-DDTHH`) in an IANA zone.
 */
export interface ToolUsageBucketing {
  timeZone: string;
  granularity: 'day' | 'hour';
}

/**
 * Which tool calls a read covers: the window, and optionally one subject
 * (null or absent is the whole tenant — the caller decides who may ask for
 * that), one tool, or a set of agents.
 */
export interface ToolCallFilter {
  window: ToolUsageWindow;
  subject?: string | null;
  tool?: string;
  agentIds?: string[];
}

export interface ToolCallCounts {
  calls: number;
  /** Calls whose status is not 'ok'. */
  errors: number;
}

export interface ToolLatency {
  /** percentile_disc(0.5 / 0.95) of duration_ms; null without calls or when not asked for. */
  medianMs: number | null;
  p95Ms: number | null;
}

export interface ToolCallsByTool extends ToolCallCounts, ToolLatency {
  tool: string;
  connector: string | null;
}

export interface ToolCallsByPerson extends ToolCallCounts {
  subject: string | null;
  displayName: string | null;
  email: string | null;
}

export interface ToolFailure {
  startedAt: Date;
  durationMs: number;
  subject: string | null;
  errorSummary: string | null;
  displayName: string | null;
  email: string | null;
}

/**
 * The `tool_calls` ledger (migration 032), content-free by construction:
 * counts, latency and who, never what a call carried.
 */
export interface ToolUsageStore {
  /**
   * Per tool and connector, most calls first (ties by tool, then connector,
   * nulls last). Latency is computed only when asked for: it costs a sort.
   */
  byTool(
    filter: ToolCallFilter,
    options: { latency: boolean; limit?: number }
  ): Promise<ToolCallsByTool[]>;
  /** One total over the filter; latency only when asked for. */
  totals(
    filter: ToolCallFilter,
    options: { latency: boolean }
  ): Promise<ToolCallCounts & ToolLatency>;
  /** Counts per local bucket, only buckets with calls, oldest first. */
  series(
    filter: ToolCallFilter,
    bucketing: ToolUsageBucketing
  ): Promise<(ToolCallCounts & { bucket: string })[]>;
  /** Per calling subject with their identity's name, most calls first (ties by subject). */
  byPerson(filter: ToolCallFilter, limit: number): Promise<ToolCallsByPerson[]>;
  /** Calls per agent, for calls stamped with one; by agent id. */
  byAgent(filter: ToolCallFilter): Promise<{ agentId: string; calls: number }[]>;
  /** The failed calls (status not 'ok'), newest first (ties by id). */
  recentFailures(filter: ToolCallFilter, limit: number): Promise<ToolFailure[]>;
  /** Append one call to the ledger. */
  recordCall(call: ToolCallEntry): Promise<void>;
}

/** One tool call as the MCP server's usage wrapper records it. */
export interface ToolCallEntry {
  id: string;
  subject: string | null;
  agentId: string | null;
  tool: string;
  connector: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  errorSummary: string | null;
}
