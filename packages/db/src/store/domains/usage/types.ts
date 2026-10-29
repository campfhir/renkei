/**
 * The usage ledgers, aggregated: tokens by surface and model (chat_turns,
 * llm_calls, image_usage, document_usage), runs (agent_run_log), tool calls
 * (tool_calls) and voice (voice_usage), over a window of whole calendar
 * days in the viewer's zone. Org-wide when `owner` is null, or narrowed to
 * one person's own chats, agents and calls.
 *
 * What the store answers is sums and counts; labels, ranks and scores are
 * the caller's (apps/web/lib/usage).
 */

/**
 * A window of whole calendar days in the viewer's zone: `days` of them, the
 * last one `endOffsetDays` before today (`{ days: 1, endOffsetDays: 1 }` is
 * yesterday). A window that runs up to today has an open end, so a row
 * written a second from now still counts.
 */
export interface UsageSpan {
  days: number;
  endOffsetDays: number;
}

export interface UsageWindow {
  span: UsageSpan;
  /** An IANA zone name the caller validated. */
  timeZone: string;
}

/** Bucket keys in the viewer's zone: YYYY-MM-DD, or YYYY-MM-DDTHH for an hourly series. */
export type UsageGranularity = 'day' | 'hour';

export interface SurfaceTokens {
  input: number;
  output: number;
}

export interface OrgTokenTotals {
  chat: SurfaceTokens;
  chatProjects: SurfaceTokens;
  codeProjects: SurfaceTokens;
  agents: SurfaceTokens;
  images: SurfaceTokens;
  documents: SurfaceTokens;
}

export interface OrgActivityTotals {
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
  /** Distinct subjects with a model call in the window; 0 when scoped to one person. */
  activeUsers: number;
  /** Everyone with an identity row; 0 when scoped. */
  totalUsers: number;
}

export interface OrgDay {
  day: string;
  chatInputTokens: number;
  chatOutputTokens: number;
  chatProjectInputTokens: number;
  chatProjectOutputTokens: number;
  codeProjectInputTokens: number;
  codeProjectOutputTokens: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  images: number;
  imageBytes: number;
  documentInputTokens: number;
  documentOutputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

/** One person's spend: their own chats' tokens, and their agents'. */
export interface SubjectSpend {
  subject: string;
  chatTokens: number;
  agentTokens: number;
}

export interface TopAgentRow {
  agentId: string;
  name: string;
  enabled: boolean;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

/** An agent's succeeded runs in the window, with what they spent and did. */
export interface SucceededAgentRuns {
  agentId: string;
  name: string;
  succeededRuns: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface OrgToolRow {
  tool: string;
  connector: string | null;
  calls: number;
  errors: number;
}

export interface ModelTokenRow {
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  calls: number;
}

export interface VoiceKindTotals {
  subject?: string;
  kind: string;
  calls: number;
  characters: number;
  audioMs: number;
}

export interface ImageTotals {
  images: number;
  bytes: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DocumentKindTotals {
  kind: string;
  count: number;
  pages: number;
  inputTokens: number;
  outputTokens: number;
}

export interface NewDocumentUsage {
  subject: string;
  artifactId: string | null;
  kind: string;
  pages: number;
  inputTokens: number;
  outputTokens: number;
}

/** One picture an image model drew (image_usage), as the caller bounded it. */
export interface NewImageUsage {
  subject: string;
  surface: string;
  provider: string;
  model: string;
  imageBytes: number;
  width: number | null;
  height: number | null;
  inputTokens: number;
  outputTokens: number;
}

/** One call to the speech service (voice_usage), as the caller bounded it. */
export interface NewVoiceUsage {
  subject: string;
  kind: string;
  characters: number;
  audioMs: number;
  provider: string;
  voice: string | null;
  locale: string | null;
}

/** One row of the token ledger (llm_calls), as a caller records it. */
export interface NewLlmCallUsage {
  subject: string;
  agentId: string | null;
  runId: string | null;
  /** A uuid, or null (the ledger's step column is typed uuid). */
  stepId: string | null;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  llmModelId: string | null;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
}

export interface UtilizationTotals {
  inputTokens: number;
  outputTokens: number;
  chatInputTokens: number;
  chatOutputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

export interface UtilizationDay {
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
  lastFailureAt: string | null;
  lastFailureStep: string | null;
  lastFailureKind: string | null;
}

export interface FailureSignature {
  agentId: string;
  agentName: string;
  stepName: string | null;
  errorKind: string | null;
  outcomeCode: string | null;
  count: number;
  lastAt: string;
  lastError: string | null;
}

export interface UsageStore {
  /** Tokens by surface: a project-less chat, a chat project, a code project, agents, images, documents. */
  surfaceTokens(window: UsageWindow, owner: string | null): Promise<OrgTokenTotals>;
  activityTotals(window: UsageWindow, owner: string | null): Promise<OrgActivityTotals>;
  /** One entry per bucket with any activity, ascending by key. */
  dailySeries(
    window: UsageWindow,
    owner: string | null,
    granularity: UsageGranularity
  ): Promise<OrgDay[]>;
  /** Everyone who spent anything in the window, by subject. */
  spendBySubject(window: UsageWindow): Promise<SubjectSpend[]>;
  /** Agents by token spend, largest first (ties by agent id), with their run counts. */
  topAgentsByTokens(
    window: UsageWindow,
    owner: string | null,
    limit: number
  ): Promise<TopAgentRow[]>;
  /** Agents with at least `minSucceededRuns` succeeded runs, by agent id. */
  succeededAgentRuns(
    window: UsageWindow,
    owner: string | null,
    minSucceededRuns: number
  ): Promise<SucceededAgentRuns[]>;
  /** Tools by call count, most first (ties by tool, then connector). */
  topTools(window: UsageWindow, owner: string | null, limit: number): Promise<OrgToolRow[]>;
  /** Models by tokens, largest first (ties by provider, then model; nulls last). */
  tokensByModel(window: UsageWindow, owner: string | null, limit: number): Promise<ModelTokenRow[]>;
  /** Voice use by kind, by kind. */
  voiceByKind(window: UsageWindow, owner: string | null): Promise<VoiceKindTotals[]>;
  /** Voice use by subject and kind, by subject then kind. */
  voiceBySubject(window: UsageWindow): Promise<Required<VoiceKindTotals>[]>;
  imageTotals(window: UsageWindow, owner: string | null): Promise<ImageTotals>;
  /** Image use by subject, by subject. */
  imageBySubject(window: UsageWindow): Promise<(ImageTotals & { subject: string })[]>;
  /** Document work by kind, by kind. */
  documentByKind(window: UsageWindow, owner: string | null): Promise<DocumentKindTotals[]>;
  recordDocument(usage: NewDocumentUsage): Promise<void>;
  /** One picture drawn, now. */
  recordImage(usage: NewImageUsage): Promise<void>;
  /** One speech-service call, now. */
  recordVoice(usage: NewVoiceUsage): Promise<void>;
  /** Add one row to the token ledger (llm_calls), dated now. */
  recordLlmCall(call: NewLlmCallUsage): Promise<void>;
  /** One person's totals across the three ledgers. */
  personTotals(subject: string, window: UsageWindow): Promise<UtilizationTotals>;
  /** One person's series, ascending by bucket key. */
  personSeries(
    subject: string,
    window: UsageWindow,
    granularity: UsageGranularity
  ): Promise<UtilizationDay[]>;
  /** Every agent the person owns, by name (ties by id), with its share of the window. */
  personAgents(subject: string, window: UsageWindow): Promise<AgentUtilizationRow[]>;
  /**
   * The person's recurring failures on enabled agents, most frequent first,
   * then most recent (further ties by agent, step, kind and outcome).
   */
  failureSignatures(
    subject: string,
    window: UsageWindow,
    limit: number
  ): Promise<FailureSignature[]>;
}
