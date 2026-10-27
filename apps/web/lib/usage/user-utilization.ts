/**
 * One person's overall utilization: tokens, agent runs, tool calls — and
 * where their agents are failing — read from three timestamped ledgers
 * and bucketed in the VIEWER's own calendar day.
 *
 * Every read here is keyed on a SUBJECT, and the subject is the caller's
 * own (the action pins it from the session before calling in). Sources:
 *
 *   - `llm_calls` (migration 085): one row per model call, attributed to
 *     the person whose spend it was — a run's owner, whoever asked for an
 *     optimization pass, or the person chatting (purpose 'chat', which
 *     the totals also report on its own).
 *   - `agent_run_log` (migration 083): one row per run of an agent this
 *     person OWNS, with its outcome and, on failure, the step and kind.
 *   - `tool_calls` (migration 032, agent stamped by 086): every MCP tool
 *     call made under this subject — their own calls from a chat client
 *     AND their agents' calls, which execute under a run token bound to
 *     the owner (RENKEI.md Decision #21). So "tool calls" means everything
 *     done as them.
 *
 * All three carry a real timestamp, which is what lets a day mean the
 * viewer's day: rows are bucketed with `AT TIME ZONE` and the window
 * starts at the viewer's midnight, so a bar shows one local day's runs
 * with that day's tool calls and tokens. Nothing here reads the per-day
 * counters (049/072) — those are keyed on the database's calendar and
 * cannot be re-cut per viewer, which is the whole reason the ledgers
 * exist. All three tables are content-free by construction.
 */

import { getDataStore, type UsageWindow } from '@renkei/db';

export interface UtilizationTotals {
  inputTokens: number;
  outputTokens: number;
  /** The part of the tokens spent in the chat (llm_calls.purpose = 'chat'). */
  chatInputTokens: number;
  chatOutputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

export interface UtilizationDay {
  /** The bucket key in the viewer's zone: YYYY-MM-DD, or YYYY-MM-DDTHH for an hourly series. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

export interface AgentUtilizationRow {
  agentId: string;
  name: string;
  enabled: boolean;
  runs: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** The most recent failure in the window, if any. */
  lastFailureAt: string | null;
  lastFailureStep: string | null;
  lastFailureKind: string | null;
}

/**
 * A recurring failure: the same agent stopping at the same step for the
 * same kind of reason. Grouped this way because "failed 12 times" is a
 * number and "stops at 'Find the ticket' with a tool error, 12 times" is
 * something a person can fix.
 */
export interface FailureSignature {
  agentId: string;
  agentName: string;
  stepName: string | null;
  errorKind: string | null;
  outcomeCode: string | null;
  count: number;
  lastAt: string;
  /** The most recent error message for this signature — the owner's own content. */
  lastError: string | null;
}

/**
 * A window of whole calendar days in the viewer's zone: `days` of them,
 * the last one `endOffsetDays` before today. `{ days: 7, endOffsetDays: 0 }`
 * is the last seven days including today; `{ days: 1, endOffsetDays: 1 }`
 * is yesterday alone — the one shape the older `days`-only helpers could
 * not express, since they always ran up to now.
 */
export interface UsageSpan {
  days: number;
  endOffsetDays: number;
}

/** The instant's wall-clock reading in `timeZone`, as if that reading were UTC. */
function wallClockMs(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (const part of format.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * Local midnight `daysBack` calendar days before `now`'s local day, as an
 * instant — `(date_trunc('day', NOW() AT TIME ZONE tz) - days) AT TIME ZONE tz`.
 */
function localMidnight(now: Date, daysBack: number, timeZone: string): Date {
  const today = new Date(wallClockMs(now.getTime(), timeZone));
  const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysBack);
  // The zone's offset at that wall time, found from a first guess and
  // corrected once for a change of offset between the two.
  let instant = wall - (wallClockMs(wall, timeZone) - wall);
  instant = wall - (wallClockMs(instant, timeZone) - instant);
  return new Date(instant);
}

/**
 * The span as instants: from local midnight of its oldest day, up to local
 * midnight of the day after its newest — open-ended when the span runs up
 * to today, so a row written a second from now still counts.
 */
export function spanWindow(span: UsageSpan, timeZone: string, now = new Date()): UsageWindow {
  const back = Math.max(0, span.endOffsetDays + span.days - 1);
  return {
    since: localMidnight(now, back, timeZone),
    until: span.endOffsetDays <= 0 ? null : localMidnight(now, span.endOffsetDays - 1, timeZone),
  };
}

export async function getUtilizationTotals(
  subject: string,
  span: UsageSpan,
  timeZone: string
): Promise<UtilizationTotals> {
  const filter = { window: spanWindow(span, timeZone), subject };
  const store = getDataStore();
  const [tokens, runs, calls] = await Promise.all([
    store.usageLedgers.llmTotals(filter),
    store.usageLedgers.runTotals(filter),
    store.toolUsage.totals(filter, { latency: false }),
  ]);
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    chatInputTokens: tokens.chatInputTokens,
    chatOutputTokens: tokens.chatOutputTokens,
    runs: runs.runs,
    failures: runs.failures,
    toolCalls: calls.calls,
    toolErrors: calls.errors,
  };
}

/**
 * The daily series, merged from the three ledgers by the viewer's calendar
 * day. Only days with activity come back; the window helper zero-fills
 * and buckets.
 */
export async function getUtilizationSeries(
  subject: string,
  span: UsageSpan,
  timeZone: string,
  granularity: 'day' | 'hour' = 'day'
): Promise<UtilizationDay[]> {
  const filter = { window: spanWindow(span, timeZone), subject };
  const bucketing = { timeZone, granularity };
  const store = getDataStore();
  const [tokenRows, runRows, callRows] = await Promise.all([
    store.usageLedgers.llmSeries(filter, bucketing),
    store.usageLedgers.runSeries(filter, bucketing),
    store.toolUsage.series(filter, bucketing),
  ]);

  const byDay = new Map<string, UtilizationDay>();
  const dayOf = (day: string): UtilizationDay => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const fresh: UtilizationDay = {
      day,
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
      failures: 0,
      toolCalls: 0,
      toolErrors: 0,
    };
    byDay.set(day, fresh);
    return fresh;
  };
  for (const row of tokenRows) {
    const point = dayOf(row.bucket);
    point.inputTokens += row.inputTokens;
    point.outputTokens += row.outputTokens;
  }
  for (const row of runRows) {
    const point = dayOf(row.bucket);
    point.runs += row.runs;
    point.failures += row.failures;
  }
  for (const row of callRows) {
    const point = dayOf(row.bucket);
    point.toolCalls += row.calls;
    point.toolErrors += row.errors;
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
}

/** Every agent this person owns, with its share of the window's usage. */
export async function getAgentUtilization(
  subject: string,
  span: UsageSpan,
  timeZone: string
): Promise<AgentUtilizationRow[]> {
  const store = getDataStore();
  const agents = await store.usageLedgers.ownedAgents(subject);
  if (agents.length === 0) return [];
  const filter = {
    window: spanWindow(span, timeZone),
    subject,
    agentIds: agents.map((agent) => agent.id),
  };

  const [runRows, tokenRows, callRows, failureRows] = await Promise.all([
    store.usageLedgers.runsByAgent(filter),
    store.usageLedgers.llmByAgent(filter),
    store.toolUsage.byAgent(filter),
    store.usageLedgers.lastFailureByAgent(filter),
  ]);
  const runs = new Map(runRows.map((row) => [row.agentId, row]));
  const tokens = new Map(tokenRows.map((row) => [row.agentId, row]));
  const calls = new Map(callRows.map((row) => [row.agentId, row]));
  const failures = new Map(failureRows.map((row) => [row.agentId, row]));

  return agents
    .map((agent) => {
      const run = runs.get(agent.id);
      const token = tokens.get(agent.id);
      const call = calls.get(agent.id);
      const failure = failures.get(agent.id);
      return {
        agentId: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        runs: run?.runs ?? 0,
        failures: run?.failures ?? 0,
        inputTokens: token?.inputTokens ?? 0,
        outputTokens: token?.outputTokens ?? 0,
        toolCalls: call?.calls ?? 0,
        lastFailureAt: failure ? failure.at.toISOString() : null,
        lastFailureStep: failure?.stepName ?? null,
        lastFailureKind: failure?.errorKind ?? null,
      };
    })
    .sort(
      (left, right) =>
        right.failures - left.failures ||
        right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens) ||
        left.name.localeCompare(right.name)
    );
}

/**
 * The recurring failures across this person's agents, most frequent
 * first. `limit` keeps the attention list a list rather than a log.
 * Disabled agents are excluded — an agent that is off is not something
 * to fix right now, and its old failures would just be noise.
 */
export async function getFailureSignatures(
  subject: string,
  span: UsageSpan,
  timeZone: string,
  limit = 5
): Promise<FailureSignature[]> {
  const rows = await getDataStore().usageLedgers.failureSignatures(
    { window: spanWindow(span, timeZone), subject },
    limit
  );
  return rows.map((row) => ({ ...row, lastAt: row.lastAt.toISOString() }));
}
