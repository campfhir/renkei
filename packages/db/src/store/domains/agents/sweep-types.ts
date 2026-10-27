/**
 * What the agents worker's sweeps read and write on an agent's memory and
 * schedule triggers (apps/worker-agents: memory-compaction.ts,
 * schedule-sweep.ts, scripts/rekey-agent-memories.ts). Contents stay as
 * stored — sealed or not, the caller opens and seals them.
 */

import type { Json } from '../../../db.types';

/** An agent whose memory has grown past the compaction threshold. */
export interface AgentMemoryCompactionCandidate {
  agentId: string;
  ownerSubject: string;
  /** How many entries (not the summary) it holds. */
  entries: number;
}

/** What one compaction pass folds: the entries past the keep window, the summary, the model. */
export interface AgentMemoryFoldSetRecord {
  /** Newest first (ties by id, descending), after the newest `keepRecent`. */
  entries: { id: string; content: string; createdAt: Date }[];
  /** The rolling summary's content as stored, or null when there is none yet. */
  summary: string | null;
  /** The agent's model, for the summarization call. */
  llmModelId: string | null;
}

/** One memory row not yet sealed, with whose key it belongs under. */
export interface AgentPlaintextMemoryRecord {
  id: string;
  content: string;
  ownerSubject: string;
}

/** An enabled schedule trigger of an enabled agent that is due, with what a run needs. */
export interface AgentDueScheduleRecord {
  triggerId: string;
  agentId: string;
  config: Json;
  nextRunAt: Date;
  ownerSubject: string;
  instructions: string;
  tools: Json;
  llmModelId: string | null;
}

export interface AgentSweepStore {
  /**
   * Agents holding more than `threshold` memory entries, most entries
   * first (ties by agent id), at most `limit`.
   */
  memoryCompactionCandidates(
    threshold: number,
    limit: number
  ): Promise<AgentMemoryCompactionCandidate[]>;
  /**
   * The agent's entries beyond its newest `keepRecent` (newest first,
   * ties by id descending, at most `limit`), its summary and its model.
   * Null when there is nothing to fold or the agent is gone.
   */
  memoryFoldSet(
    agentId: string,
    options: { keepRecent: number; limit: number }
  ): Promise<AgentMemoryFoldSetRecord | null>;
  /**
   * Delete every entry beyond the agent's newest `keep` (newest first, ties
   * by id descending); returns how many went.
   */
  trimMemoryEntries(agentId: string, keep: number): Promise<number>;
  /**
   * Memory rows (entries and summaries, every agent) whose content does not
   * start with `sealedPrefix`, by id, after `afterId` when given, at most
   * `limit`, with their agent's owner.
   */
  listPlaintextMemory(options: {
    afterId: string | null;
    sealedPrefix: string;
    limit: number;
  }): Promise<AgentPlaintextMemoryRecord[]>;
  /** Replace one memory row's content only while it is still `expected`; false otherwise. */
  replaceMemoryContent(id: string, expected: string, content: string): Promise<boolean>;

  /**
   * Enabled schedule triggers of enabled agents whose next run is at or
   * before `now`, soonest first (ties by trigger id), at most `limit`.
   */
  listDueScheduleTriggers(now: Date, limit: number): Promise<AgentDueScheduleRecord[]>;
  /** Turn a trigger off with the reason recorded. */
  disableTrigger(triggerId: string, lastError: string): Promise<void>;
  /**
   * The optimistic lock: move the trigger's next run from `observed` to
   * `next`, stamping it fired now. False when its next run is no longer
   * `observed` (another sweep won).
   */
  advanceScheduleTrigger(triggerId: string, observed: Date, next: Date): Promise<boolean>;
  /** Record (or, null, clear) a trigger's last error. */
  setTriggerError(triggerId: string, lastError: string | null): Promise<void>;
}
