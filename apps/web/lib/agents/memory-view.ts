/**
 * What an agent remembers, for the owner's pages: the rolling summary and
 * the newest entries, read through the data store and opened as the
 * owner — the same answer `readAgentMemory` (@renkei/agents/memory) gives
 * the worker, which keeps reading the table itself.
 *
 * Sealed under the owner's automation key; opened through the delegate. A
 * key that is not available comes back as `unavailable`, never as a
 * half-read memory.
 */

import { getDataStore } from '@renkei/db';
import { openAgentMemoryContents, type AgentMemory } from '@renkei/agents/memory';

export async function readAgentMemoryView(
  agentId: string,
  maxEntries: number
): Promise<AgentMemory> {
  const slice = await getDataStore().agents.memorySlice(agentId, maxEntries);
  const none: AgentMemory = {
    summary: null,
    summaryUpdatedAt: null,
    entries: [],
    unavailable: null,
  };
  if (slice.summary === null && slice.entries.length === 0) return none;
  if (slice.ownerSubject === null) return { ...none, unavailable: 'NO_USER_KEY' };

  const opened = await openAgentMemoryContents(slice.ownerSubject, [
    ...(slice.summary ? [slice.summary.content] : []),
    ...slice.entries.map((entry) => entry.content),
  ]);
  if (!opened.ok) return { ...none, unavailable: opened.reason };
  const offset = slice.summary ? 1 : 0;
  return {
    summary: slice.summary ? opened.contents[0] : null,
    summaryUpdatedAt: slice.summary ? slice.summary.updatedAt : null,
    entries: slice.entries.map((entry, index) => ({
      id: entry.id,
      content: opened.contents[index + offset],
      createdAt: entry.createdAt,
    })),
    unavailable: null,
  };
}

/** Forget everything the agent remembers; returns how many rows went. */
export async function clearAgentMemory(agentId: string): Promise<number> {
  return getDataStore().agents.clearMemory(agentId);
}
