/**
 * Memory compaction — the sweep that keeps agent memory EXPRESSIVE, not
 * the one that keeps prompts small (that guarantee is render-time, in
 * @renkei/agents/memory). When an agent's entry count crosses the
 * threshold, the older entries are folded into the agent's one rolling
 * summary by the agent's OWN model (BYO-LLM, same resolution as runs),
 * and the folded rows are deleted; the newest entries stay verbatim.
 *
 * Failure posture, in order of preference:
 *  - LLM unavailable/failed → leave everything, retry next sweep.
 *  - Still over MEMORY_HARD_CAP anyway (compaction failing repeatedly) →
 *    trim the oldest entries mechanically with a loud warn. Bounded
 *    storage beats unbounded fidelity; the render budget never let those
 *    entries into a prompt anyway.
 *
 * Replica races are benign by construction: two sweeps folding the same
 * entries write equivalent summaries (last write wins) and the entry
 * deletes are idempotent — wasted LLM spend at worst, never data loss.
 * Entries appended AFTER a sweep read its fold set are untouched, since
 * deletion is by id.
 */

import { getDataStore } from '@renkei/db';
import { resolveAgentLlm } from '@renkei/agent-llm';
import {
  openAgentMemoryContents,
  writeAgentMemorySummary,
  MEMORY_COMPACT_THRESHOLD,
  MEMORY_KEEP_RECENT,
  MEMORY_HARD_CAP,
  MEMORY_SUMMARY_MAX_CHARS,
} from '@renkei/agents/memory';
import { logger } from './logger';

export const MEMORY_COMPACTION_SWEEP_MS = 15 * 60_000;

/** Agents compacted per pass; the backlog drains across passes. */
const MAX_AGENTS_PER_PASS = 10;
/** Entries folded per agent per pass — bounds the summarization prompt. */
const MAX_FOLD_BATCH = 60;

const COMPACTION_SYSTEM_PROMPT =
  'You maintain the long-term memory of an automated agent. Merge the standing summary and ' +
  'the listed notes into ONE updated summary. Preserve every identifier needed to avoid ' +
  'repeating work (message ids, ticket keys, dates, names); collapse repetition; drop ' +
  'chatter with no future value. Write plain compact prose or short bullet lines. ' +
  `Stay under ${MEMORY_SUMMARY_MAX_CHARS} characters. Reply with the summary text only.`;

export function createMemoryCompactionSweep() {
  return async function sweep(): Promise<void> {
    const candidates = await getDataStore().agents.memoryCompactionCandidates(
      MEMORY_COMPACT_THRESHOLD,
      MAX_AGENTS_PER_PASS
    );

    for (const candidate of candidates) {
      try {
        await compactOne(candidate.agentId, candidate.ownerSubject);
      } catch (error) {
        logger.warn('memory compaction failed for agent {agentId}: {error}', {
          component: 'worker-agents/memory-compaction',
          agentId: candidate.agentId,
          subject: candidate.ownerSubject,
          error: error instanceof Error ? error.message : String(error),
        });
        await enforceHardCap(candidate.agentId, candidate.ownerSubject);
      }
    }
  };
}

async function compactOne(agentId: string, ownerSubject: string): Promise<void> {
  // Oldest-beyond-the-keep-window, capped: the fold set. Null when there is
  // nothing to fold, or the agent is gone (the FK cascade took its memory).
  const foldSet = await getDataStore().agents.memoryFoldSet(agentId, {
    keepRecent: MEMORY_KEEP_RECENT,
    limit: MAX_FOLD_BATCH,
  });
  if (!foldSet) return;
  const { entries, summary: summaryContent } = foldSet;

  const llmResult = await resolveAgentLlm(foldSet.llmModelId);
  if (!llmResult.ok) {
    throw new Error(llmResult.err.message ?? `no model to compact with (${llmResult.err.type})`);
  }
  const llm = llmResult.val;

  // The rows are sealed under the owner's automation key (memory.ts);
  // opened here as the owner, in one call, or the pass is left for the
  // next sweep — a summary folded from envelopes would be garbage.
  const opened = await openAgentMemoryContents(ownerSubject, [
    ...(summaryContent !== null ? [summaryContent] : []),
    ...entries.map((entry) => entry.content),
  ]);
  if (!opened.ok) {
    throw new Error(`memory could not be opened under the owner's key (${opened.reason})`);
  }
  const summaryText = summaryContent !== null ? opened.contents[0] : null;
  const entryTexts = opened.contents.slice(summaryContent !== null ? 1 : 0);

  // Oldest first, so the model reads a timeline.
  const noteLines = [...entries]
    .map((entry, index) => ({ at: entry.createdAt, text: entryTexts[index] }))
    .reverse()
    .map((entry) => `- [${entry.at.toISOString().slice(0, 10)}] ${entry.text}`)
    .join('\n');
  const prompt =
    (summaryText ? `Standing summary:\n${summaryText}\n\n` : 'Standing summary: (none yet)\n\n') +
    `Notes to fold in, oldest first:\n${noteLines}`;

  const completion = await llm.provider.complete({
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    maxTokens: llm.maxOutputTokens,
    ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
  });
  if (!completion.ok) {
    throw new Error(completion.err.message ?? `model failed (${completion.err.type})`);
  }
  const summary = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  if (!summary) throw new Error('the model returned an empty summary');

  // Summary FIRST, then the deletes: a crash between the two leaves the
  // folded entries present AND summarized — duplication the next fold
  // collapses — never a hole.
  await writeAgentMemorySummary(agentId, summary);
  await getDataStore().agents.deleteMemoryEntries(
    agentId,
    entries.map((entry) => entry.id)
  );

  logger.info('compacted {folded} memory entr(ies) for agent {agentId}', {
    component: 'worker-agents/memory-compaction',
    agentId,
    subject: ownerSubject,
    folded: entries.length,
  });
}

/** The lossy last resort, only past the hard cap: drop the oldest rows. */
async function enforceHardCap(agentId: string, ownerSubject: string): Promise<void> {
  const dropped = await getDataStore().agents.trimMemoryEntries(agentId, MEMORY_HARD_CAP);
  if (dropped === 0) return;
  logger.warn(
    'memory hard cap: dropped {dropped} oldest entr(ies) for agent {agentId} uncompacted',
    {
      component: 'worker-agents/memory-compaction',
      agentId,
      subject: ownerSubject,
      dropped,
    }
  );
}
