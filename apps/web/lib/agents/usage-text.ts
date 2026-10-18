/**
 * Token and tool usage rendered as plain text for the agents-over-MCP
 * tools — the same cards the agent page's usage panel shows (overall, by
 * model, by step, tools by connector) and the same per-run figure the
 * run pages could show, written for a model to read rather than a
 * browser to lay out.
 *
 * One figure format throughout: "12,400 in (3,100 cached) · 900 out ·
 * 200 cache writes". Cached prompt tokens are a PORTION of the input
 * (see TokenStat), so the parenthesis says how much of the input was
 * the cheap kind; cache writes are listed only when there were any.
 *
 * Pure: every function here takes rows the ledger queries in
 * `agent-usage.ts` already returned, so the wording is unit-tested away
 * from the database.
 */

import { modelLabel } from './model-label';
import { periodLabel, type UsagePeriod } from './usage-periods';
import type {
  AgentToolUsageRow,
  ModelTokenUsage,
  RunModelTokenUsage,
  RunTokenTotals,
  TokenUsage,
  UsageBuckets,
} from './agent-usage';
import { sumRunTotals } from './agent-usage';

const number = (value: number) => value.toLocaleString('en-US');

interface Figure {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** "12,400 in (3,100 cached) · 900 out · 200 cache writes" */
export function tokenFigure(figure: Figure): string {
  const cached = figure.cacheRead > 0 ? ` (${number(figure.cacheRead)} cached)` : '';
  const writes = figure.cacheWrite > 0 ? ` · ${number(figure.cacheWrite)} cache writes` : '';
  return `${number(figure.input)} in${cached} · ${number(figure.output)} out${writes}`;
}

function bucketFigure(usage: TokenUsage, bucket: UsagePeriod): Figure {
  return {
    input: usage.input[bucket],
    output: usage.output[bucket],
    cacheRead: usage.cacheRead[bucket],
    cacheWrite: usage.cacheWrite[bucket],
  };
}

function spent(figure: Figure): number {
  return figure.input + figure.output;
}

function formatMs(ms: number): string {
  if (ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function callCount(calls: number): string {
  return `${number(calls)} model ${calls === 1 ? 'call' : 'calls'}`;
}

/** The per-model lines for one period, largest first, models with nothing spent left out. */
function modelLines(rows: readonly ModelTokenUsage[], bucket: UsagePeriod): string[] {
  return rows
    .map((row) => ({ row, figure: bucketFigure(row, bucket) }))
    .filter((entry) => spent(entry.figure) > 0)
    .sort((a, b) => spent(b.figure) - spent(a.figure))
    .map(
      (entry) =>
        `- ${modelLabel(entry.row.provider, entry.row.model)}: ${tokenFigure(entry.figure)}`
    );
}

/** Tool calls grouped by connector, busiest connector first — the panel's "Tools used" card. */
function toolLines(rows: readonly AgentToolUsageRow[]): string[] {
  const groups = new Map<string | null, AgentToolUsageRow[]>();
  for (const row of rows) {
    const list = groups.get(row.connector) ?? [];
    list.push(row);
    groups.set(row.connector, list);
  }
  const callsOf = (list: AgentToolUsageRow[]) => list.reduce((sum, row) => sum + row.calls, 0);
  const lines: string[] = [];
  for (const [connector, list] of [...groups.entries()].sort(
    (a, b) => callsOf(b[1]) - callsOf(a[1])
  )) {
    lines.push(`${connector ?? 'other'}:`);
    for (const row of list) {
      const errors = row.errors > 0 ? ` · ${number(row.errors)} failed` : '';
      const latency =
        row.p95Ms > 0 ? ` · median ${formatMs(row.medianMs)}, p95 ${formatMs(row.p95Ms)}` : '';
      lines.push(
        `- ${row.tool}: ${number(row.calls)} ${row.calls === 1 ? 'call' : 'calls'}${errors}${latency}`
      );
    }
  }
  return lines;
}

export interface AgentUsageText {
  agentName: string;
  agentId: string;
  period: UsagePeriod;
  tokens: TokenUsage;
  byModel: readonly ModelTokenUsage[];
  tools: readonly AgentToolUsageRow[];
  toolWindowDays: number;
}

/**
 * One agent's usage, the way its page's usage panel shows it: the token
 * totals for every period at once (the page's period pills, without a
 * round trip per period), then the chosen period's split by model, and
 * the tool calls over the trailing window.
 */
export function renderAgentUsageText(input: AgentUsageText): string {
  const label = periodLabel(input.period).toLowerCase();
  const lines = [
    `Usage of "${input.agentName}" (agentId: ${input.agentId})`,
    '',
    'Tokens by period (cached = the portion of the input served from cache):',
    ...(['today', 'yesterday', 'week', 'month', 'quarter', 'year', 'allTime'] as const).map(
      (bucket: keyof UsageBuckets) =>
        `- ${periodLabel(bucket)}: ${tokenFigure(bucketFigure(input.tokens, bucket))}`
    ),
  ];

  const models = modelLines(input.byModel, input.period);
  lines.push(
    '',
    `By model · ${label}:`,
    ...(models.length > 0 ? models : [`- no tokens ${label}`])
  );

  const calls = input.tools.reduce((sum, row) => sum + row.calls, 0);
  const errors = input.tools.reduce((sum, row) => sum + row.errors, 0);
  lines.push(
    '',
    `Tool calls, last ${input.toolWindowDays} days: ${number(calls)}${errors > 0 ? ` (${number(errors)} failed)` : ''}`,
    ...(input.tools.length > 0 ? toolLines(input.tools) : ['- none'])
  );
  return lines.join('\n');
}

export interface AgentUsageLine {
  agentId: string;
  name: string;
  /** Who shared it, for an agent that is not the caller's own. */
  sharedBy?: string;
  tokens: TokenUsage;
}

/**
 * Every agent the caller can reach, one line each for the chosen period,
 * largest spend first — the oversight page's per-card numbers, and the
 * usage page's "by agent" section, as a list.
 */
export function renderAgentsUsageText(
  period: UsagePeriod,
  agents: readonly AgentUsageLine[]
): string {
  const label = periodLabel(period).toLowerCase();
  const entries = agents
    .map((agent) => ({ agent, figure: bucketFigure(agent.tokens, period) }))
    .sort((a, b) => spent(b.figure) - spent(a.figure));
  const total = entries.reduce(
    (sum, entry) => ({
      input: sum.input + entry.figure.input,
      output: sum.output + entry.figure.output,
      cacheRead: sum.cacheRead + entry.figure.cacheRead,
      cacheWrite: sum.cacheWrite + entry.figure.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  );
  const lines = [`Token usage of ${entries.length} agent(s) · ${label}: ${tokenFigure(total)}`, ''];
  for (const { agent, figure } of entries) {
    lines.push(
      `- ${agent.name}${agent.sharedBy ? ` (shared by ${agent.sharedBy})` : ''}: ${tokenFigure(figure)}`,
      `  agentId: ${agent.agentId}`
    );
  }
  lines.push('', 'Give an agentId for its usage by model and its tool calls.');
  return lines.join('\n');
}

/** "tokens: 12,400 in (3,100 cached) · 900 out · 3 model calls" — one run's line in a listing. */
export function runTokenLine(totals: RunTokenTotals): string {
  return `tokens: ${tokenFigure(totals)} · ${callCount(totals.calls)}`;
}

/**
 * The "## Token usage" section under a run's debug markdown: the run's
 * total, then by model. Empty when the ledger has nothing for the run —
 * a queued run, or one pruned past the org's usage retention.
 */
export function renderRunUsageMarkdown(rows: readonly RunModelTokenUsage[]): string {
  const lines = ['## Token usage', ''];
  if (rows.length === 0) {
    lines.push('No model calls recorded for this run.');
    return lines.join('\n');
  }
  lines.push(
    `- Total: ${tokenFigure(sumRunTotals(rows))} · ${callCount(sumRunTotals(rows).calls)}`
  );

  const byModel = new Map<string, RunTokenTotals[]>();
  for (const row of rows) {
    const key = modelLabel(row.provider, row.model);
    const list = byModel.get(key) ?? [];
    list.push(row);
    byModel.set(key, list);
  }
  lines.push('', '### By model', '');
  for (const [name, list] of [...byModel.entries()].sort(
    (a, b) => spent(sumRunTotals(b[1])) - spent(sumRunTotals(a[1]))
  )) {
    lines.push(`- ${name}: ${tokenFigure(sumRunTotals(list))}`);
  }
  return lines.join('\n');
}
