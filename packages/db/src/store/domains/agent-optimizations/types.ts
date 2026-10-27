import type { Json } from '../../../db.types';

/** One optimization pass over an agent, as stored. */
export interface AgentOptimizationRecord {
  id: string;
  agentId: string;
  ownerSubject: string;
  status: string;
  request: Json;
  result: Json | null;
  error: string | null;
  errorDetail: string | null;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  createdAt: Date;
  finishedAt: Date | null;
  appliedAt: Date | null;
}

export type OptimizationOutcome =
  | { status: 'succeeded'; result: Json; inputTokens: number; outputTokens: number }
  /** Error text and detail as given; the caller bounds their length. */
  | { status: 'failed'; error: string; detail: string | null };

export interface AgentOptimizationStore {
  /** Queue a pass; returns its id. */
  create(input: { ownerSubject: string; agentId: string; request: Json }): Promise<string>;
  /** One of the owner's passes, or null. */
  find(ownerSubject: string, optimizationId: string): Promise<AgentOptimizationRecord | null>;
  /** The owner's newest pass over the agent, whatever its status (ties by id). */
  latest(ownerSubject: string, agentId: string): Promise<AgentOptimizationRecord | null>;
  /** The newest queued or running pass over the agent, anyone's (ties by id). */
  inFlight(agentId: string): Promise<{ id: string } | null>;
  /** Move a queued pass to running, counting the attempt; false when it was not queued. */
  claim(optimizationId: string): Promise<boolean>;
  /** Record a pass's outcome, finished now. */
  finish(optimizationId: string, outcome: OptimizationOutcome): Promise<void>;
  /**
   * Note that the owner turned the report into a draft: `draftId` joins
   * the stored result (jsonb `||`), applied now.
   */
  markApplied(ownerSubject: string, optimizationId: string, draftId: string): Promise<void>;
  /** Remove a pass (one whose job could not be queued). */
  delete(optimizationId: string): Promise<void>;
}
