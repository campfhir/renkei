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

import { getDataStore, type ChatSurface } from '@renkei/db';
import { spanWindow, type UsageSpan } from './user-utilization';

export type { UsageSpan };

export interface SurfaceTokens {
  input: number;
  output: number;
}

/** Every kind of spend the org has, with nothing left uncounted. */
export interface OrgTokenTotals {
  chat: SurfaceTokens;
  chatProjects: SurfaceTokens;
  codeProjects: SurfaceTokens;
  agents: SurfaceTokens;
  /**
   * What image generation models billed (image_usage, migration 132). Only
   * models that report tokens count here — gpt-image does, FLUX does not —
   * so a FLUX-only org shows 0 even with pictures drawn; the Images card
   * counts those by the picture and the byte.
   */
  images: SurfaceTokens;
  /**
   * What the model billed for summaries of uploaded files and descriptions
   * of their pictures (document_usage, migration 168), charged to the uploader.
   * OCR bills pages rather than tokens, so its reads are counted on the
   * Documents card and not here.
   */
  documents: SurfaceTokens;
}

export interface OrgActivityTotals {
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
  /** Distinct subjects with at least one token spent somewhere in the window; 0 when scoped to one person. */
  activeUsers: number;
  /** Everyone who has ever signed in to this tenant — the activity rate's denominator; 0 when scoped. */
  totalUsers: number;
}

export interface OrgDay {
  /** The bucket key in the viewer's zone: YYYY-MM-DD, or YYYY-MM-DDTHH for an hourly series. */
  day: string;
  chatInputTokens: number;
  chatOutputTokens: number;
  chatProjectInputTokens: number;
  chatProjectOutputTokens: number;
  codeProjectInputTokens: number;
  codeProjectOutputTokens: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  /** What image generation models billed this hour or day, and the pictures behind it. */
  imageInputTokens: number;
  imageOutputTokens: number;
  images: number;
  imageBytes: number;
  /** What the model billed for summaries and picture descriptions this hour or day. */
  documentInputTokens: number;
  documentOutputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

const EMPTY_SURFACE: SurfaceTokens = { input: 0, output: 0 };

/**
 * The chat surface split: a chat with no project is `'chat'`, a project's
 * chat is `'chat_project'` unless the project is a code project (`kind =
 * 'code'`), in which case it's `'code'`. The store groups by it, so a row
 * never has to be re-labeled on the way out.
 */
function surfaceOf(
  rows: readonly { surface: ChatSurface; inputTokens: number; outputTokens: number }[],
  surface: ChatSurface
): SurfaceTokens {
  const row = rows.find((candidate) => candidate.surface === surface);
  return row ? { input: row.inputTokens, output: row.outputTokens } : EMPTY_SURFACE;
}

const tokens = (row: { inputTokens: number; outputTokens: number }): SurfaceTokens => ({
  input: row.inputTokens,
  output: row.outputTokens,
});

/**
 * Token totals by surface — org-wide when `ownerSubject` is null, or
 * narrowed to one person's own chats, projects and agents when it isn't.
 */
export async function getSurfaceTokenTotals(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<OrgTokenTotals> {
  const filter = { window: spanWindow(span, timeZone), subject: ownerSubject };
  const ledgers = getDataStore().usageLedgers;
  const [chatRows, agentTotals, imageTotals, documentRows] = await Promise.all([
    ledgers.chatTokensBySurface(filter),
    ledgers.llmTotals({ ...filter, agentsOnly: true }),
    ledgers.imageTotals(filter),
    ledgers.documentByKind(filter),
  ]);
  return {
    chat: surfaceOf(chatRows, 'chat'),
    chatProjects: surfaceOf(chatRows, 'chat_project'),
    codeProjects: surfaceOf(chatRows, 'code'),
    agents: tokens(agentTotals),
    images: tokens(imageTotals),
    documents: {
      input: documentRows.reduce((total, row) => total + row.inputTokens, 0),
      output: documentRows.reduce((total, row) => total + row.outputTokens, 0),
    },
  };
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
  const window = spanWindow(span, timeZone);
  const filter = { window, subject: ownerSubject };
  const store = getDataStore();
  const [runs, calls, active, total] = await Promise.all([
    store.usageLedgers.runTotals(filter),
    store.toolUsage.totals(filter, { latency: false }),
    ownerSubject === null ? store.usageLedgers.countActiveSubjects(window) : Promise.resolve(0),
    ownerSubject === null ? store.usageLedgers.countPeople() : Promise.resolve(0),
  ]);
  return {
    runs: runs.runs,
    failures: runs.failures,
    toolCalls: calls.calls,
    toolErrors: calls.errors,
    activeUsers: active,
    totalUsers: total,
  };
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
  const filter = { window: spanWindow(span, timeZone), subject: ownerSubject };
  const bucketing = { timeZone, granularity };
  const store = getDataStore();
  const ledgers = store.usageLedgers;
  const [chatRows, agentRows, runRows, callRows, imageRows, documentRows] = await Promise.all([
    ledgers.chatSeriesBySurface(filter, bucketing),
    ledgers.llmSeries({ ...filter, agentsOnly: true }, bucketing),
    ledgers.runSeries(filter, bucketing),
    store.toolUsage.series(filter, bucketing),
    ledgers.imageSeries(filter, bucketing),
    ledgers.documentSeries(filter, bucketing),
  ]);

  const byDay = new Map<string, OrgDay>();
  const dayOf = (day: string): OrgDay => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const fresh: OrgDay = {
      day,
      chatInputTokens: 0,
      chatOutputTokens: 0,
      chatProjectInputTokens: 0,
      chatProjectOutputTokens: 0,
      codeProjectInputTokens: 0,
      codeProjectOutputTokens: 0,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      imageInputTokens: 0,
      imageOutputTokens: 0,
      images: 0,
      imageBytes: 0,
      documentInputTokens: 0,
      documentOutputTokens: 0,
      runs: 0,
      failures: 0,
      toolCalls: 0,
      toolErrors: 0,
    };
    byDay.set(day, fresh);
    return fresh;
  };
  for (const row of chatRows) {
    const point = dayOf(row.bucket);
    if (row.surface === 'chat') {
      point.chatInputTokens += row.inputTokens;
      point.chatOutputTokens += row.outputTokens;
    } else if (row.surface === 'chat_project') {
      point.chatProjectInputTokens += row.inputTokens;
      point.chatProjectOutputTokens += row.outputTokens;
    } else {
      point.codeProjectInputTokens += row.inputTokens;
      point.codeProjectOutputTokens += row.outputTokens;
    }
  }
  for (const row of agentRows) {
    const point = dayOf(row.bucket);
    point.agentInputTokens += row.inputTokens;
    point.agentOutputTokens += row.outputTokens;
  }
  for (const row of imageRows) {
    const point = dayOf(row.bucket);
    point.imageInputTokens += row.inputTokens;
    point.imageOutputTokens += row.outputTokens;
    point.images += row.images;
    point.imageBytes += row.bytes;
  }
  for (const row of documentRows) {
    const point = dayOf(row.bucket);
    point.documentInputTokens += row.inputTokens;
    point.documentOutputTokens += row.outputTokens;
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
  const filter = { window: spanWindow(span, timeZone) };
  const store = getDataStore();
  const [chatRows, agentRows, identityRows] = await Promise.all([
    store.usageLedgers.chatTokensBySubject(filter),
    store.usageLedgers.agentLlmBySubject(filter),
    store.identities.list(),
  ]);

  const identityBySubject = new Map(identityRows.map((row) => [row.subject, row]));
  const chatBySubject = new Map(chatRows.map((row) => [row.subject, row]));
  const agentBySubject = new Map(agentRows.map((row) => [row.subject, row]));
  const subjects = new Set<string>([...chatBySubject.keys(), ...agentBySubject.keys()]);

  const rows: TopUserRow[] = [...subjects].map((subject) => {
    const chat = chatBySubject.get(subject);
    const agent = agentBySubject.get(subject);
    const chatTokens = (chat?.inputTokens ?? 0) + (chat?.outputTokens ?? 0);
    const agentTokens = (agent?.inputTokens ?? 0) + (agent?.outputTokens ?? 0);
    const identity = identityBySubject.get(subject);
    return {
      subject,
      label: identity?.displayName || identity?.email || subject,
      chatTokens,
      agentTokens,
      totalTokens: chatTokens + (includeAgents ? agentTokens : 0),
    };
  });

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
  const rows = await getDataStore().identities.list();
  return rows
    .map((row) => ({ subject: row.subject, label: row.displayName || row.email || row.subject }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export interface TopAgentRow {
  agentId: string;
  name: string;
  enabled: boolean;
  inputTokens: number;
  outputTokens: number;
  runs: number;
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
  const filter = { window: spanWindow(span, timeZone), subject: ownerSubject };
  const ledgers = getDataStore().usageLedgers;
  const rows = await ledgers.topAgentsByTokens(filter, limit);
  if (rows.length === 0) return [];

  const runRows = await ledgers.runsByAgent({
    ...filter,
    agentIds: rows.map((row) => row.agentId),
  });
  const runsByAgent = new Map(runRows.map((row) => [row.agentId, row.runs]));

  return rows.map((row) => ({
    agentId: row.agentId,
    name: row.name,
    enabled: row.enabled,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    runs: runsByAgent.get(row.agentId) ?? 0,
  }));
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
  const rows = await getDataStore().usageLedgers.succeededRunStats(
    { window: spanWindow(span, timeZone), subject: ownerSubject },
    minSucceededRuns
  );

  const scored: EfficientAgentRow[] = rows.map((row) => {
    const succeededRuns = row.runs;
    const tokens = row.inputTokens + row.outputTokens;
    const toolCalls = row.toolCalls;
    return {
      agentId: row.agentId,
      name: row.name,
      succeededRuns,
      tokens,
      toolCalls,
      tokensPerRun: succeededRuns > 0 ? Math.round(tokens / succeededRuns) : 0,
      toolCallsPerRun: succeededRuns > 0 ? toolCalls / succeededRuns : 0,
      efficiency: tokens > 0 ? (toolCalls / tokens) * 1000 : 0,
    };
  });

  return scored.sort((left, right) => right.efficiency - left.efficiency).slice(0, limit);
}

export interface OrgToolRow {
  tool: string;
  connector: string | null;
  calls: number;
  errors: number;
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
  const rows = await getDataStore().toolUsage.byTool(
    { window: spanWindow(span, timeZone), subject: ownerSubject },
    { latency: false, limit }
  );
  return rows.map((row) => ({
    tool: row.tool,
    connector: row.connector,
    calls: row.calls,
    errors: row.errors,
  }));
}

export interface ModelTokenRow {
  provider: string | null;
  /** Null for ledger rows written before the model was recorded. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** The part of `inputTokens` served from the prompt cache. */
  cachedInputTokens: number;
  /** Model calls — one ledger row each. */
  calls: number;
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
  return getDataStore().usageLedgers.tokensByModel(
    { window: spanWindow(span, timeZone), subject: ownerSubject },
    limit
  );
}
