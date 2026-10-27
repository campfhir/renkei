import type { Json } from '../../../db.types';

/** One background draft of an agent from prose, as stored. */
export interface AgentDraftRecord {
  id: string;
  agentId: string | null;
  ownerSubject: string;
  status: string;
  request: Json;
  result: Json | null;
  error: string | null;
  errorDetail: string | null;
  attempts: number;
  createdAt: Date;
  finishedAt: Date | null;
  consumedAt: Date | null;
}

export type DraftOutcome =
  | { status: 'succeeded'; result: Json }
  /** Error text and detail as given; the caller bounds their length. */
  | { status: 'failed'; error: string; detail: string | null };

export interface AgentDraftStore {
  /** Queue a draft (for an agent of the owner's, or for a new one); returns its id. */
  create(input: { ownerSubject: string; agentId: string | null; request: Json }): Promise<string>;
  /** One of the owner's drafts, or null. */
  find(ownerSubject: string, draftId: string): Promise<AgentDraftRecord | null>;
  /**
   * The owner's newest succeeded, not yet consumed draft for the agent
   * (null: for a new agent), ties by id.
   */
  latestReady(ownerSubject: string, agentId: string | null): Promise<AgentDraftRecord | null>;
  /** Mark one of the owner's drafts as loaded into the builder. */
  consume(ownerSubject: string, draftId: string): Promise<void>;
  /** Move a queued draft to running, counting the attempt; false when it was not queued. */
  claim(draftId: string): Promise<boolean>;
  /** Record a draft's outcome, finished now. */
  finish(draftId: string, outcome: DraftOutcome): Promise<void>;
  /** Remove a draft (one whose job could not be queued). */
  delete(draftId: string): Promise<void>;
}
