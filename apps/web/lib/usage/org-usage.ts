/**
 * Organization-wide utilization: tokens by surface (chat, chat projects,
 * code projects, agents) and by model, how much of the org is actually
 * using it, and the leaderboards an operator needs — who spends the most,
 * which agents cost the most, and which agents get the most tool-call
 * work done per token. The tenant-wide counterpart to
 * `user-utilization.ts`, read from the same content-free ledgers.
 *
 * Every read takes a `UsageSpan` (whole calendar days in the viewer's
 * zone, possibly ending before today — "yesterday") and most take an
 * optional `ownerSubject` that narrows the same query to one person's own
 * chats, agents and tool calls. That is how Organization Usage scopes to
 * a selected person and how "My usage" reuses the same SQL for the
 * caller's own subject. Null is always what widens back to the whole
 * tenant, matching `getAgentUsageSummaries`'s convention.
 *
 * The one thing `llm_calls` (085) cannot say on its own is which CHAT a
 * `purpose = 'chat'` row belongs to — that ledger carries no chat id, only
 * a subject. So the chat/chat-project/code-project split is read instead
 * from `chat_turns` (092), which already carries `input_tokens` and
 * `output_tokens` per turn and links back through `chats.project_id` to a
 * `chat_projects.kind`. Both ledgers are written from the same accumulated
 * totals at the end of a turn (`turn-runner.ts`), so they agree; only the
 * grouping differs.
 */

import { getDataStore } from '@renkei/db';
import type {
  ModelTokenRow,
  OrgActivityTotals,
  OrgDay,
  OrgTokenTotals,
  OrgToolRow,
  SurfaceTokens,
  TopAgentRow,
  UsageSpan,
} from '@renkei/db';

/**
 * The record shapes come from the data store's usage domain
 * (packages/db/src/store/domains/usage/types.ts):
 *
 *   - OrgTokenTotals: every kind of spend the org has — chat, chat
 *     projects, code projects, agents, images (only models that report
 *     tokens count: gpt-image does, FLUX does not) and documents (summaries
 *     and picture descriptions; OCR bills pages, counted on the Documents
 *     card instead);
 *   - OrgActivityTotals: runs and tool calls, plus — org-wide only — how
 *     many people spent anything against how many have ever signed in;
 *   - OrgDay: one bucket of the trend chart and activity calendar;
 *   - TopAgentRow, OrgToolRow, ModelTokenRow: the leaderboards' rows.
 */
export type {
  ModelTokenRow,
  OrgActivityTotals,
  OrgDay,
  OrgTokenTotals,
  OrgToolRow,
  SurfaceTokens,
  TopAgentRow,
  UsageSpan,
};

/**
 * Token totals by surface — org-wide when `ownerSubject` is null, or
 * narrowed to one person's own chats, projects and agents when it isn't.
 */
export async function getSurfaceTokenTotals(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<OrgTokenTotals> {
  return getDataStore().usage.surfaceTokens({ span, timeZone }, ownerSubject);
}

/**
 * Runs and tool calls over the window, plus — org-wide only — how many
 * people spent anything against how many have ever signed in. Scoped to
 * one person the two user counts are meaningless and come back as 0; the
 * page shows that person's active days instead.
 */
export async function getOrgActivityTotals(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<OrgActivityTotals> {
  return getDataStore().usage.activityTotals({ span, timeZone }, ownerSubject);
}

/**
 * The series behind the trend chart and the activity calendar, one row
 * per calendar day (or per hour, for a one-day window) in the viewer's
 * zone with every surface's tokens plus runs and tool calls. Active-user
 * counts are deliberately NOT part of this series: summing a day's
 * distinct subjects across a multi-day bucket would count the same person
 * once per day they were active, which is a different (and less honest)
 * number than the period's actual reach — that number comes from
 * `getOrgActivityTotals` instead, computed once over the whole window.
 */
export async function getOrgDailySeries(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null,
  granularity: 'day' | 'hour' = 'day'
): Promise<OrgDay[]> {
  return getDataStore().usage.dailySeries({ span, timeZone }, ownerSubject, granularity);
}

export interface TopUserRow {
  subject: string;
  label: string;
  /** Tokens across the person's own chats, chat projects and code projects. */
  chatTokens: number;
  /** Tokens across the agents this person owns — separate, foldable into the rank on request. */
  agentTokens: number;
  /** `chatTokens`, plus `agentTokens` when the caller asked to include them. */
  totalTokens: number;
}

/** Each subject's display label: the name, else the email, else the subject itself. */
export async function labelsBySubject(): Promise<Map<string, string>> {
  const identities = await getDataStore().identities.list();
  return new Map(
    identities.map((identity) => [
      identity.subject,
      identity.displayName || identity.email || identity.subject,
    ])
  );
}

/** A subject's label, from `labelsBySubject`. */
export function labelOf(labels: Map<string, string>, subject: string): string {
  return labels.get(subject) ?? subject;
}

/**
 * People ranked by how much they've spent — chat, chat-project and
 * code-project tokens by default, with agent spend folded into the same
 * rank when `includeAgents` is set. Both figures are always returned so a
 * UI can show the split even while ranking on the combined total. With no
 * `limit` every spender comes back, ranked, so a caller can find where
 * one person stands without a second query.
 */
export async function getTopUsers(
  span: UsageSpan,
  timeZone: string,
  includeAgents: boolean,
  limit?: number
): Promise<TopUserRow[]> {
  const [spend, labels] = await Promise.all([
    getDataStore().usage.spendBySubject({ span, timeZone }),
    labelsBySubject(),
  ]);
  const rows: TopUserRow[] = spend.map((row) => ({
    subject: row.subject,
    label: labelOf(labels, row.subject),
    chatTokens: row.chatTokens,
    agentTokens: row.agentTokens,
    totalTokens: row.chatTokens + (includeAgents ? row.agentTokens : 0),
  }));
  const ranked = rows.sort(
    (left, right) => right.totalTokens - left.totalTokens || left.label.localeCompare(right.label)
  );
  return limit === undefined ? ranked : ranked.slice(0, limit);
}

export interface PersonOption {
  subject: string;
  label: string;
}

/** Everyone who has signed in, for the person picker — names only. */
export async function listPeople(): Promise<PersonOption[]> {
  const identities = await getDataStore().identities.list();
  return identities
    .map((row) => ({ subject: row.subject, label: row.displayName || row.email || row.subject }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Agents ranked by token spend over the window — the org's biggest agent
 * bills, or one person's when scoped (`llm_calls.subject` is the run's
 * owner, so an agent shows under whoever pays for it).
 */
export async function getTopAgentsByTokens(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null,
  limit = 10
): Promise<TopAgentRow[]> {
  return getDataStore().usage.topAgentsByTokens({ span, timeZone }, ownerSubject, limit);
}

export interface EfficientAgentRow {
  agentId: string;
  name: string;
  succeededRuns: number;
  tokens: number;
  toolCalls: number;
  tokensPerRun: number;
  toolCallsPerRun: number;
  /** Tool calls per 1,000 tokens spent — higher means more work done per token. */
  efficiency: number;
}

/**
 * Agents doing the most actual work per token: among SUCCEEDED runs only
 * (a cheap run that fails proves nothing), tool calls per token spent —
 * an agent that runs cheaply but never calls a tool (nothing to check, or
 * nothing to do) is not "efficient" by this measure, it's idle. Weighting
 * by tool calls rather than ranking on raw tokens-per-run alone is the
 * point: it separates an agent that gets real work done cheaply from one
 * that is merely cheap.
 *
 * `minSucceededRuns` keeps a single lucky run from topping the list —
 * three by default, low enough for a new agent to qualify within a normal
 * reporting window.
 *
 * `ownerSubject` narrows to one person's own agents; null ranks every
 * agent in the tenant.
 */
export async function getMostEfficientAgents(
  span: UsageSpan,
  timeZone: string,
  limit = 10,
  minSucceededRuns = 3,
  ownerSubject: string | null = null
): Promise<EfficientAgentRow[]> {
  const rows = await getDataStore().usage.succeededAgentRuns(
    { span, timeZone },
    ownerSubject,
    minSucceededRuns
  );
  const scored: EfficientAgentRow[] = rows.map((row) => {
    const tokens = row.inputTokens + row.outputTokens;
    return {
      agentId: row.agentId,
      name: row.name,
      succeededRuns: row.succeededRuns,
      tokens,
      toolCalls: row.toolCalls,
      tokensPerRun: row.succeededRuns > 0 ? Math.round(tokens / row.succeededRuns) : 0,
      toolCallsPerRun: row.succeededRuns > 0 ? row.toolCalls / row.succeededRuns : 0,
      efficiency: tokens > 0 ? (row.toolCalls / tokens) * 1000 : 0,
    };
  });
  return scored.sort((left, right) => right.efficiency - left.efficiency).slice(0, limit);
}

/**
 * The most-used tools over the window — org-wide (the same ranking the
 * tools page's "org top" card shows), or everything one person did as
 * themselves: their own calls from a chat client and their agents' calls,
 * which run under a token bound to the owner.
 */
export async function getTopToolsOrg(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null,
  limit = 10
): Promise<OrgToolRow[]> {
  return getDataStore().usage.topTools({ span, timeZone }, ownerSubject, limit);
}

/**
 * Token spend by model over the window — the breakdown that makes a token
 * count mean something as a cost, since a million tokens on a frontier
 * model and a million on a small one are not the same bill. Reads every
 * `llm_calls` row (chat, agents and optimizer passes alike), so the total
 * here is the whole ledger, not just the surfaces the chat split can
 * name. Scoped to one person on request. Largest first; rows written
 * before the model was recorded surface as one null-model row.
 */
export async function getTokensByModel(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null,
  limit = 10
): Promise<ModelTokenRow[]> {
  return getDataStore().usage.tokensByModel({ span, timeZone }, ownerSubject, limit);
}
