/**
 * A half-open range of instants: `since` inclusive, `until` exclusive, or
 * open-ended when `until` is null/absent. The caller works out the
 * instants (the viewer's local midnights); the store only compares.
 */
export interface UsageWindow {
  since: Date;
  until?: Date | null;
}

/**
 * A row's bucket: its local calendar day (`YYYY-MM-DD`) or hour
 * (`YYYY-MM-DDTHH`) in an IANA zone.
 */
export interface Bucketing {
  timeZone: string;
  granularity: 'day' | 'hour';
}

/** The window, and optionally one person (null or absent: the whole tenant). */
export interface LedgerFilter {
  window: UsageWindow;
  subject?: string | null;
}

export interface TokenSums {
  inputTokens: number;
  outputTokens: number;
}

/** Where a chat turn's tokens went: a chat with no project, a project's chat, or a code project's. */
export type ChatSurface = 'chat' | 'chat_project' | 'code';

export interface ImageSums extends TokenSums {
  images: number;
  bytes: number;
}

export interface VoiceSums {
  calls: number;
  characters: number;
  audioMs: number;
}

export interface DocumentSums extends TokenSums {
  count: number;
  pages: number;
}

export interface FailureSignatureRecord {
  agentId: string;
  agentName: string;
  stepName: string | null;
  errorKind: string | null;
  outcomeCode: string | null;
  count: number;
  lastAt: Date;
  lastError: string | null;
}

/**
 * The content-free usage ledgers behind "My usage" and Organization usage:
 * `llm_calls` (085), `agent_run_log` (083), `chat_turns` (092, with its
 * chat and project), `image_usage` (132), `voice_usage` and
 * `document_usage` (168). Every read is a sum or count over a window,
 * optionally narrowed to one subject — the subject column of each ledger
 * (`owner_subject` for runs, the chat's owner for chat turns). Sums over
 * no rows are 0. Lists without a stated order come back in their key
 * order (bucket, agent id, subject, …).
 */
export interface UsageLedgerStore {
  /** Model tokens; `chat*` is the part with purpose 'chat'. `agentsOnly`: rows with an agent. */
  llmTotals(
    filter: LedgerFilter & { agentsOnly?: boolean }
  ): Promise<TokenSums & { chatInputTokens: number; chatOutputTokens: number }>;
  /** Model tokens per local bucket, only buckets with rows, oldest first. */
  llmSeries(
    filter: LedgerFilter & { agentsOnly?: boolean },
    bucketing: Bucketing
  ): Promise<(TokenSums & { bucket: string })[]>;
  /** Model tokens per agent among `agentIds`, by agent id. */
  llmByAgent(
    filter: LedgerFilter & { agentIds: string[] }
  ): Promise<(TokenSums & { agentId: string })[]>;
  /** Agent model tokens (rows with an agent) per paying subject, by subject. */
  agentLlmBySubject(filter: LedgerFilter): Promise<(TokenSums & { subject: string })[]>;
  /** Agents by model token spend, largest first (ties by agent id), with the agent's name. */
  topAgentsByTokens(
    filter: LedgerFilter,
    limit: number
  ): Promise<(TokenSums & { agentId: string; name: string; enabled: boolean })[]>;
  /**
   * Tokens per provider and model, largest first (ties by provider then
   * model, nulls last), with cached input and call counts.
   */
  tokensByModel(
    filter: LedgerFilter,
    limit: number
  ): Promise<
    (TokenSums & {
      provider: string | null;
      model: string | null;
      cachedInputTokens: number;
      calls: number;
    })[]
  >;
  /** Distinct subjects with a model call in the window. */
  countActiveSubjects(window: UsageWindow): Promise<number>;

  /** Agent runs and failed runs. */
  runTotals(filter: LedgerFilter): Promise<{ runs: number; failures: number }>;
  runSeries(
    filter: LedgerFilter,
    bucketing: Bucketing
  ): Promise<{ bucket: string; runs: number; failures: number }[]>;
  /** Runs per agent among `agentIds`, by agent id. */
  runsByAgent(
    filter: LedgerFilter & { agentIds: string[] }
  ): Promise<{ agentId: string; runs: number; failures: number }[]>;
  /** Each agent's newest failed run in the window, among `agentIds`, by agent id. */
  lastFailureByAgent(
    filter: LedgerFilter & { agentIds: string[] }
  ): Promise<{ agentId: string; at: Date; stepName: string | null; errorKind: string | null }[]>;
  /**
   * Failed runs of ENABLED agents grouped by agent, step, error kind and
   * outcome code: most frequent first, then most recent (ties by agent id,
   * step, kind, code), with the newest error message of each.
   */
  failureSignatures(filter: LedgerFilter, limit: number): Promise<FailureSignatureRecord[]>;
  /** Succeeded runs per agent, for agents with at least `minRuns` of them; by agent id. */
  succeededRunStats(
    filter: LedgerFilter,
    minRuns: number
  ): Promise<(TokenSums & { agentId: string; name: string; runs: number; toolCalls: number })[]>;

  /** Chat-turn tokens per surface; surfaces without turns are left out. Narrowed by chat owner. */
  chatTokensBySurface(filter: LedgerFilter): Promise<(TokenSums & { surface: ChatSurface })[]>;
  chatSeriesBySurface(
    filter: LedgerFilter,
    bucketing: Bucketing
  ): Promise<(TokenSums & { bucket: string; surface: ChatSurface })[]>;
  /** Chat-turn tokens per chat owner, by subject. */
  chatTokensBySubject(filter: LedgerFilter): Promise<(TokenSums & { subject: string })[]>;

  imageTotals(filter: LedgerFilter): Promise<ImageSums>;
  imageSeries(
    filter: LedgerFilter,
    bucketing: Bucketing
  ): Promise<(ImageSums & { bucket: string })[]>;
  imageBySubject(filter: LedgerFilter): Promise<(ImageSums & { subject: string })[]>;

  /** Voice usage per kind ('speech', 'transcription', …), by kind. */
  voiceByKind(filter: LedgerFilter): Promise<(VoiceSums & { kind: string })[]>;
  /** Voice usage per subject and kind, by subject then kind. */
  voiceBySubjectKind(
    filter: LedgerFilter
  ): Promise<(VoiceSums & { subject: string; kind: string })[]>;

  /** Document usage per kind ('ocr', 'summary', 'describe'), by kind. */
  documentByKind(filter: LedgerFilter): Promise<(DocumentSums & { kind: string })[]>;
  documentSeries(
    filter: LedgerFilter,
    bucketing: Bucketing
  ): Promise<(TokenSums & { bucket: string })[]>;
  /** Record one document job (OCR, summary, description), billed to the uploader. */
  insertDocumentUsage(input: {
    subject: string;
    artifactId: string | null;
    kind: string;
    pages: number;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void>;

  /** The agents a person owns, by name (ties by id). */
  ownedAgents(subject: string): Promise<{ id: string; name: string; enabled: boolean }[]>;
  /** Everyone who has ever signed in (distinct identities). */
  countPeople(): Promise<number>;
}
