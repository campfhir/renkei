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
 * viewer's day: rows are bucketed in that zone (the data store's usage
 * domain) and the window starts at the viewer's midnight, so a bar shows one local day's runs
 * with that day's tool calls and tokens. Nothing here reads the per-day
 * counters (049/072) — those are keyed on the database's calendar and
 * cannot be re-cut per viewer, which is the whole reason the ledgers
 * exist. All three tables are content-free by construction.
 */

import { getDataStore } from '@renkei/db';
import type {
  AgentUtilizationRow,
  FailureSignature,
  UsageSpan,
  UtilizationDay,
  UtilizationTotals,
} from '@renkei/db';

/**
 * The record shapes come from the data store's usage domain
 * (packages/db/src/store/domains/usage/types.ts):
 *
 *   - UtilizationTotals: tokens (with the chat share, llm_calls.purpose =
 *     'chat'), runs, failures, tool calls and errors;
 *   - UtilizationDay: the same per bucket key in the viewer's zone
 *     (YYYY-MM-DD, or YYYY-MM-DDTHH for an hourly series);
 *   - AgentUtilizationRow: one owned agent's share of the window, with its
 *     most recent failure;
 *   - FailureSignature: a recurring failure — the same agent stopping at the
 *     same step for the same kind of reason, grouped because "stops at
 *     'Find the ticket' with a tool error, 12 times" is something a person
 *     can fix;
 *   - UsageSpan: whole calendar days in the viewer's zone, `days` of them,
 *     the last one `endOffsetDays` before today.
 */
export type { AgentUtilizationRow, FailureSignature, UsageSpan, UtilizationDay, UtilizationTotals };

export async function getUtilizationTotals(
  subject: string,
  span: UsageSpan,
  timeZone: string
): Promise<UtilizationTotals> {
  return getDataStore().usage.personTotals(subject, { span, timeZone });
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
  return getDataStore().usage.personSeries(subject, { span, timeZone }, granularity);
}

/**
 * Every agent this person owns, with its share of the window's usage: the
 * ones failing most first, then the costliest, then by name.
 */
export async function getAgentUtilization(
  subject: string,
  span: UsageSpan,
  timeZone: string
): Promise<AgentUtilizationRow[]> {
  const agents = await getDataStore().usage.personAgents(subject, { span, timeZone });
  return agents.sort(
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
  return getDataStore().usage.failureSignatures(subject, { span, timeZone }, limit);
}
