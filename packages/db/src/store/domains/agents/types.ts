import type { Json } from '../../../db.types';

/** One trigger row of an agent, as stored (config is the jsonb the builder wrote). */
export interface AgentTriggerRecord {
  id: string;
  agentId: string;
  kind: string;
  eventSource: string | null;
  eventType: string | null;
  config: Json;
  enabled: boolean;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

/** One agent definition, with its triggers (oldest first, ties by id). */
export interface AgentRecord {
  id: string;
  ownerSubject: string;
  name: string;
  description: string | null;
  descriptionStatus: string;
  reviewNotes: Json | null;
  instructions: string;
  tools: Json;
  stepsVersion: number;
  llmModelId: string | null;
  enabled: boolean;
  guardrails: string | null;
  canAskQuestions: boolean;
  autoAcceptActions: boolean;
  createdAt: Date;
  updatedAt: Date;
  triggers: AgentTriggerRecord[];
}

/** The definition columns a save writes. `tools` is stored as given (a JSON array). */
export interface AgentDefinitionValues {
  name: string;
  instructions: string;
  tools: string[];
  llmModelId: string | null;
  enabled: boolean;
  guardrails: string | null;
  canAskQuestions: boolean;
  autoAcceptActions: boolean;
}

/** What a trigger reconcile does to an agent's rows, decided by the caller. */
export interface AgentTriggerChanges {
  update: {
    id: string;
    eventSource: string | null;
    eventType: string | null;
    /** JSON text, canonical as the caller serialized it. */
    config: string;
    enabled: boolean;
    nextRunAt: Date | null;
  }[];
  insert: {
    id: string;
    kind: string;
    eventSource: string | null;
    eventType: string | null;
    config: string;
    enabled: boolean;
    nextRunAt: Date | null;
  }[];
  /** Trigger ids to delete. */
  remove: string[];
}

/** An unexpired grant that admits a viewer. */
export interface AgentActiveGrantRecord {
  id: string;
  ownerSubject: string;
  expiresAt: Date | null;
}

/** One row of the owner's sharing list, joined to the grantee's identity. */
export interface AgentGrantRecord {
  id: string;
  granteeSubject: string;
  granteeName: string | null;
  granteeEmail: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** A grant that shares someone's agent with the viewer, joined to the owner's identity. */
export interface AgentSharedWithRecord {
  agentId: string;
  ownerSubject: string;
  ownerName: string | null;
  ownerEmail: string | null;
  expiresAt: Date | null;
}

/** One agent as the operator's oversight pages list it. */
export interface AgentAdminRecord {
  id: string;
  name: string;
  ownerSubject: string;
  ownerEmail: string | null;
  enabled: boolean;
  description: string | null;
  descriptionStatus: string;
  /** The newest retained run's creation time. */
  lastRunAt: Date | null;
}

/** One stored chunk of an agent's knowledge notes. `content` is as stored (sealed or not). */
export interface AgentNoteChunkRecord {
  refId: string;
  metadata: Json;
  content: string;
  keywords: string[] | null;
  sourceAt: Date | null;
}

/** The rows the memory view opens: content as stored (sealed under the owner's key). */
export interface AgentMemorySliceRecord {
  /** The agent's owner — whose key opens the rows; null when the agent is gone. */
  ownerSubject: string | null;
  summary: { content: string; updatedAt: Date } | null;
  /** Newest first, at most `maxEntries`. */
  entries: { id: string; content: string; createdAt: Date }[];
}

export interface AgentStore {
  /** One owner's agents, newest first (ties by id). */
  list(ownerSubject: string): Promise<AgentRecord[]>;
  /**
   * One agent by id, or null. With `ownerSubject`, only that owner's —
   * someone else's id reads as missing. The id must be a uuid (22P02
   * otherwise, as Postgres refuses the cast).
   */
  find(agentId: string, options?: { ownerSubject?: string }): Promise<AgentRecord | null>;
  /** One owner's agents as {id, name}, by name (ties by id). */
  listNames(ownerSubject: string): Promise<{ id: string; name: string }[]>;
  /**
   * The owner's agents chained AFTER `callerAgentId`: one entry per enabled
   * `agent` trigger whose config names it as the caller, by agent name,
   * then agent id, then trigger id.
   */
  listChainedAfter(
    callerAgentId: string,
    ownerSubject: string
  ): Promise<{ id: string; name: string }[]>;
  /** Every agent name that matches `prefix%` as a LIKE pattern (wildcards in it act), by name. */
  namesLike(prefix: string): Promise<string[]>;
  /** Insert a definition (description stale, revision 1). A name in use is NAME_TAKEN. */
  create(
    agent: { id: string; ownerSubject: string } & AgentDefinitionValues
  ): Promise<'CREATED' | 'NAME_TAKEN'>;
  /**
   * Rewrite one owner's definition and bump its revision. The description
   * goes stale unless `markDescriptionStale` is false.
   */
  update(
    ownerSubject: string,
    agentId: string,
    values: AgentDefinitionValues,
    options: { markDescriptionStale: boolean }
  ): Promise<'UPDATED' | 'NOT_FOUND' | 'NAME_TAKEN'>;
  /** Delete one owner's agent (runs, triggers, grants cascade); false when it was not theirs. */
  delete(ownerSubject: string, agentId: string): Promise<boolean>;
  /** Store a generated description and review notes, or mark the attempt failed. */
  saveDescription(
    agentId: string,
    outcome: { status: 'ok'; description: string; reviewNotes: Json } | { status: 'failed' }
  ): Promise<void>;
  /** Mark the description stale (a re-describe is about to run). */
  markDescriptionStale(agentId: string): Promise<void>;
  /** The agent's trigger rows, oldest first (ties by id). */
  listTriggers(agentId: string): Promise<AgentTriggerRecord[]>;
  /** Apply a reconcile: updates, inserts and deletes of this agent's triggers, all or none. */
  applyTriggerChanges(agentId: string, changes: AgentTriggerChanges): Promise<void>;

  /** The grant admitting `granteeSubject` to the agent, if it has not expired. */
  findActiveGrant(agentId: string, granteeSubject: string): Promise<AgentActiveGrantRecord | null>;
  /** Grant, or refresh the expiry of an existing grant to the same person. */
  upsertGrant(grant: {
    id: string;
    agentId: string;
    ownerSubject: string;
    granteeSubject: string;
    expiresAt: Date | null;
  }): Promise<void>;
  /** Every grant on the agent, expired ones included, oldest first (ties by id). */
  listGrants(agentId: string): Promise<AgentGrantRecord[]>;
  /** Delete one of the owner's grants on the agent; returns who it admitted, or null. */
  revokeGrant(
    ownerSubject: string,
    agentId: string,
    grantId: string
  ): Promise<{ granteeSubject: string } | null>;
  /** Unexpired grants to this person, newest first (ties by id). */
  listSharedWith(granteeSubject: string): Promise<AgentSharedWithRecord[]>;
  /** How many unexpired grants the agent has. */
  countActiveGrants(agentId: string): Promise<number>;

  /** Every agent (or one owner's), by name then id, with the owner's email and last run. */
  listForAdmin(options: { ownerSubject: string | null }): Promise<AgentAdminRecord[]>;
  findForAdmin(agentId: string): Promise<AgentAdminRecord | null>;

  /**
   * The chunks of the agent's knowledge notes (provider `provider`, metadata
   * agentId and scope matching), by ref id.
   */
  listNoteChunks(
    agentId: string,
    options: { provider: string; scope: string }
  ): Promise<AgentNoteChunkRecord[]>;
  /** Whether the note `refId` (or one of its `#` chunks) exists for the agent. */
  noteExists(
    agentId: string,
    refId: string,
    options: { provider: string; scope: string }
  ): Promise<boolean>;
  /**
   * Copy one note's chunks (`baseRef` and `baseRef#…`) under `newBase`,
   * stamped with the target agent; every derived column rides along.
   * Returns how many chunks were written.
   */
  copyNoteChunks(input: {
    provider: string;
    baseRef: string;
    newBase: string;
    targetAgentId: string;
  }): Promise<number>;

  /**
   * The newest slice of the agent's memory: up to `maxEntries` entries,
   * newest first (ties by id, descending), and the summary row.
   */
  memorySlice(agentId: string, maxEntries: number): Promise<AgentMemorySliceRecord>;
  /** Forget all of the agent's memory; returns how many rows went. */
  clearMemory(agentId: string): Promise<number>;
}
