/**
 * What an operator decides about one person's token limits (migration 175):
 * who is exempt, and the boosts granted for the week or month in progress.
 * and what a person has spent of the token ledger (`llm_calls`: their chats,
 * their agents' runs and every other model call made as them) since an
 * instant. The limits are organization settings; putting the three together
 * is @renkei/settings'.
 */

export type TokenLimitPeriod = 'week' | 'month';

/** A person no token limit applies to. */
export interface TokenLimitExemptionRecord {
  subject: string;
  setBy: string;
  createdAt: Date;
}

/** Extra tokens for one person until `expiresAt`, the end of the period it was granted in. */
export interface TokenLimitBoostRecord {
  id: string;
  subject: string;
  period: TokenLimitPeriod;
  tokens: number;
  expiresAt: Date;
  grantedBy: string;
  note: string | null;
  createdAt: Date;
}

export type NewTokenLimitBoost = Omit<TokenLimitBoostRecord, 'createdAt'>;

/** Tokens (input plus output) one person spent on one model; `llmModelId` null for calls that named none. */
export interface ModelSpend {
  llmModelId: string | null;
  tokens: number;
}

export interface SubjectSpendSince {
  subject: string;
  tokens: number;
}

export interface TokenLimitStore {
  /** What one person spent since `since`, per model, by model id (the null model last). */
  spentSince(subject: string, since: Date): Promise<ModelSpend[]>;
  /** Everyone who spent anything since `since`, by subject. */
  spentBySubjectSince(since: Date): Promise<SubjectSpendSince[]>;
  /** Everyone exempt, by subject. */
  listExempt(): Promise<TokenLimitExemptionRecord[]>;
  isExempt(subject: string): Promise<boolean>;
  /** Exempt a person, or put them back under the limits; saying it twice changes nothing. */
  setExempt(subject: string, exempt: boolean, setBy: string): Promise<void>;
  /** Record a boost under the caller's id, dated now. */
  grantBoost(boost: NewTokenLimitBoost): Promise<void>;
  /**
   * The boosts still running at `now` (`expiresAt` after it), oldest grant
   * first (ties by id); everyone's, or one person's.
   */
  activeBoosts(now: Date, subject?: string): Promise<TokenLimitBoostRecord[]>;
  /** Take a boost back; false when there is none with this id. */
  revokeBoost(id: string): Promise<boolean>;
}
