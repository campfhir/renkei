/**
 * renkei_my_usage and renkei_org_usage — the numbers the My usage and
 * Organization usage pages show, as text the model can answer from.
 *
 * Whose numbers is never an input. renkei_my_usage reads the subject the
 * turn runs as and nothing else; renkei_org_usage is built only for a
 * turn whose session carries the operator role (index.ts), and checks the
 * role again when called — the same two gates the pages' own actions
 * have (app/(app)/utilization/actions.ts, app/(app)/admin/usage/actions.ts).
 * Both read the same ledgers through lib/usage, cut in the person's own
 * calendar days, and say where the full page is.
 */

import { formatTokens } from '@/lib/format-tokens';
import {
  getAgentUtilization,
  getFailureSignatures,
  getUtilizationTotals,
  type UsageSpan,
} from '@/lib/usage/user-utilization';
import {
  getOrgActivityTotals,
  getSurfaceTokenTotals,
  getTokensByModel,
  getTopAgentsByTokens,
  getTopToolsOrg,
  getTopUsers,
  type ModelTokenRow,
  type OrgTokenTotals,
  type OrgToolRow,
  type TopAgentRow,
} from '@/lib/usage/org-usage';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from '../local-tools';
import { timeZoneOf } from '../time-zone';
import { isOperator, markdownLink } from './shared';

export const MY_USAGE_TOOL = 'renkei_my_usage';
export const ORG_USAGE_TOOL = 'renkei_org_usage';

/**
 * The windows the usage pages offer, by the same keys
 * (app/(app)/utilization/window.ts's UTILIZATION_PERIODS — usage.test.ts
 * holds the two lists equal).
 */
export const USAGE_PERIODS: readonly (UsageSpan & { key: string; label: string })[] = [
  { key: 'today', label: 'today', days: 1, endOffsetDays: 0 },
  { key: 'yesterday', label: 'yesterday', days: 1, endOffsetDays: 1 },
  { key: '1w', label: 'the last 7 days', days: 7, endOffsetDays: 0 },
  { key: '1m', label: 'the last 30 days', days: 30, endOffsetDays: 0 },
  { key: '1q', label: 'the last 90 days', days: 90, endOffsetDays: 0 },
  { key: '1y', label: 'the last year', days: 365, endOffsetDays: 0 },
];
const DEFAULT_PERIOD = '1m';

function periodOf(input: Record<string, unknown>) {
  return (
    USAGE_PERIODS.find((period) => period.key === input.period) ??
    USAGE_PERIODS.find((period) => period.key === DEFAULT_PERIOD)!
  );
}

const PERIOD_SCHEMA = {
  type: 'string',
  enum: USAGE_PERIODS.map((period) => period.key),
  description:
    'The window: today, yesterday, 1w (7 days), 1m (30 days, the default), 1q (90 days) or 1y.',
};

const SURFACES: readonly { key: keyof OrgTokenTotals; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'chatProjects', label: 'Chat projects' },
  { key: 'codeProjects', label: 'Code projects' },
  { key: 'agents', label: 'Agents' },
  { key: 'images', label: 'Images' },
  { key: 'documents', label: 'Documents' },
];

const tokens = (input: number, output: number) =>
  `${formatTokens(input + output)} tokens (${formatTokens(input)} in, ${formatTokens(output)} out)`;

function surfaceLines(totals: OrgTokenTotals): string[] {
  const used = SURFACES.filter(({ key }) => totals[key].input + totals[key].output > 0);
  if (used.length === 0) return ['No tokens were spent.'];
  const all = SURFACES.reduce(
    (sum, { key }) => ({
      input: sum.input + totals[key].input,
      output: sum.output + totals[key].output,
    }),
    { input: 0, output: 0 }
  );
  return [
    `Total: ${tokens(all.input, all.output)}`,
    ...used.map(({ key, label }) => `- ${label}: ${tokens(totals[key].input, totals[key].output)}`),
  ];
}

function modelLines(rows: ModelTokenRow[]): string[] {
  return rows.map(
    (row) =>
      `- ${row.model ?? 'unrecorded model'}${row.provider ? ` (${row.provider})` : ''}: ${tokens(row.inputTokens, row.outputTokens)} over ${row.calls} call(s)`
  );
}

function agentLines(rows: TopAgentRow[]): string[] {
  return rows.map(
    (row) =>
      `- ${row.name}${row.enabled ? '' : ' (off)'}: ${tokens(row.inputTokens, row.outputTokens)} over ${row.runs} run(s)`
  );
}

function toolLines(rows: OrgToolRow[]): string[] {
  return rows.map(
    (row) => `- ${row.tool}: ${row.calls} call(s)${row.errors > 0 ? `, ${row.errors} failed` : ''}`
  );
}

function section(title: string, lines: string[]): string {
  return lines.length > 0 ? `\n\n${title}\n${lines.join('\n')}` : '';
}

const TOP = 5;

async function myUsage(input: Record<string, unknown>, context: LocalToolContext) {
  const period = periodOf(input);
  const timeZone = timeZoneOf(context.timeZone) ?? 'UTC';
  const subject = context.subject;
  const [totals, surfaces, byModel, topTools, agents, attention] = await Promise.all([
    getUtilizationTotals(subject, period, timeZone),
    getSurfaceTokenTotals(period, timeZone, subject),
    getTokensByModel(period, timeZone, subject, TOP),
    getTopToolsOrg(period, timeZone, subject, TOP),
    getAgentUtilization(subject, period, timeZone),
    getFailureSignatures(subject, period, timeZone),
  ]);
  const ranAgents = agents.filter((agent) => agent.runs > 0).slice(0, TOP);
  return textResult(
    `This person's own usage over ${period.label} (days cut in ${timeZone}):\n` +
      surfaceLines(surfaces).join('\n') +
      `\n\nAgent runs: ${totals.runs}${totals.failures > 0 ? `, ${totals.failures} failed` : ''}` +
      `\nTool calls: ${totals.toolCalls}${totals.toolErrors > 0 ? `, ${totals.toolErrors} failed` : ''}` +
      section('By model:', modelLines(byModel)) +
      section('Most-used tools:', toolLines(topTools)) +
      section(
        'Their agents:',
        ranAgents.map(
          (agent) =>
            `- ${agent.name}: ${agent.runs} run(s)${agent.failures > 0 ? `, ${agent.failures} failed` : ''}, ${tokens(agent.inputTokens, agent.outputTokens)}`
        )
      ) +
      section(
        'Recurring failures:',
        attention.map(
          (failure) =>
            `- ${failure.agentName} stopped at "${failure.stepName ?? 'a step'}" ${failure.count} time(s)${failure.lastError ? `: ${failure.lastError}` : ''}`
        )
      ) +
      `\n\nThe full report, with charts: ${markdownLink(context, 'My usage', '/utilization')}`
  );
}

async function orgUsage(input: Record<string, unknown>, context: LocalToolContext) {
  // Built for operators only; asked again here, behind the tool.
  if (!isOperator(context)) {
    return errorResult("Organization usage is for the organization's operators.");
  }
  const period = periodOf(input);
  const timeZone = timeZoneOf(context.timeZone) ?? 'UTC';
  const [surfaces, activity, users, topAgents, topTools, byModel] = await Promise.all([
    getSurfaceTokenTotals(period, timeZone),
    getOrgActivityTotals(period, timeZone),
    getTopUsers(period, timeZone, true, TOP),
    getTopAgentsByTokens(period, timeZone, null, TOP),
    getTopToolsOrg(period, timeZone, null, TOP),
    getTokensByModel(period, timeZone, null, TOP),
  ]);
  return textResult(
    `The organization's usage over ${period.label} (days cut in ${timeZone}):\n` +
      surfaceLines(surfaces).join('\n') +
      `\n\nActive people: ${activity.activeUsers} of ${activity.totalUsers} who have signed in` +
      `\nAgent runs: ${activity.runs}${activity.failures > 0 ? `, ${activity.failures} failed` : ''}` +
      `\nTool calls: ${activity.toolCalls}${activity.toolErrors > 0 ? `, ${activity.toolErrors} failed` : ''}` +
      section(
        'Who spent the most (chats and their agents):',
        users.map(
          (row) =>
            `- ${row.label}: ${formatTokens(row.totalTokens)} tokens (${formatTokens(row.chatTokens)} chat, ${formatTokens(row.agentTokens)} agents)`
        )
      ) +
      section('By model:', modelLines(byModel)) +
      section('Agents by spend:', agentLines(topAgents)) +
      section('Most-used tools:', toolLines(topTools)) +
      `\n\nThe full report, with charts and a person picker: ${markdownLink(context, 'Organization usage', '/admin/usage')}`
  );
}

export function myUsageTool(): LocalTool {
  return {
    readOnly: true,
    def: {
      name: MY_USAGE_TOOL,
      description:
        "This person's own usage of Renkei, the numbers their My usage page shows: tokens by where they were spent (chat, projects, code, agents, images, documents) and by model, agent runs and failures, tool calls and the tools used most. Use it when they ask how much they have used or what their agents cost. It reads only the person in this chat; nobody else's numbers can be asked for here.",
      inputSchema: { type: 'object', properties: { period: PERIOD_SCHEMA } },
    },
    execute: myUsage,
  };
}

/** For operators (index.ts builds it only for them); found through find_tools. */
export function orgUsageTool(): LocalTool {
  return {
    readOnly: true,
    deferred: true,
    def: {
      name: ORG_USAGE_TOOL,
      description:
        "The whole organization's usage of Renkei, the numbers the Organization usage page shows to operators: tokens by surface and by model, how many people were active, who spent the most, the costliest agents and the tools used most. Counts only — never what any chat or call contained.",
      inputSchema: { type: 'object', properties: { period: PERIOD_SCHEMA } },
    },
    execute: orgUsage,
  };
}
