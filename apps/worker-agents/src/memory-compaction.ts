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

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveAgentLlm } from '@renkei/agent-llm';
import {
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

export function createMemoryCompactionSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const candidates = await db
      .selectFrom('agent_memories as m')
      .innerJoin('agents as a', 'a.id', 'm.agent_id')
      .select([
        'm.tenant_id as tenant_id',
        'm.agent_id as agent_id',
        'a.owner_subject as owner_subject',
        sql<string>`count(*)`.as('entries'),
      ])
      .where('m.kind', '=', 'entry')
      .groupBy(['m.tenant_id', 'm.agent_id', 'a.owner_subject'])
      .having(sql`count(*)`, '>', MEMORY_COMPACT_THRESHOLD)
      .orderBy(sql`count(*)`, 'desc')
      .limit(MAX_AGENTS_PER_PASS)
      .execute();

    for (const candidate of candidates) {
      try {
        await compactOne(db, candidate.tenant_id, candidate.agent_id, candidate.owner_subject);
      } catch (error) {
        logger.warn('memory compaction failed for agent {agentId}: {error}', {
          component: 'worker-agents/memory-compaction',
          agentId: candidate.agent_id,
          tenantId: candidate.tenant_id,
          subject: candidate.owner_subject,
          error: error instanceof Error ? error.message : String(error),
        });
        await enforceHardCap(db, candidate.tenant_id, candidate.agent_id, candidate.owner_subject);
      }
    }
  };
}

async function compactOne(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  ownerSubject: string
): Promise<void> {
  // Oldest-beyond-the-keep-window, capped: the fold set.
  const entries = await db
    .selectFrom('agent_memories')
    .select(['id', 'content', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('kind', '=', 'entry')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(MEMORY_KEEP_RECENT)
    .limit(MAX_FOLD_BATCH)
    .execute();
  if (entries.length === 0) return;

  const summaryRow = await db
    .selectFrom('agent_memories')
    .select(['content'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('kind', '=', 'summary')
    .executeTakeFirst();

  const agentRow = await db
    .selectFrom('agents')
    .select(['llm_model_id'])
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (!agentRow) {
    // Agent gone; the FK cascade will have taken the memory with it.
    return;
  }

  const llmResult = await resolveAgentLlm(db, tenantId, agentRow.llm_model_id);
  if (!llmResult.ok) {
    throw new Error(llmResult.err.message ?? `no model to compact with (${llmResult.err.type})`);
  }
  const llm = llmResult.val;

  // Oldest first, so the model reads a timeline.
  const noteLines = [...entries]
    .reverse()
    .map((entry) => `- [${entry.created_at.toISOString().slice(0, 10)}] ${entry.content}`)
    .join('\n');
  const prompt =
    (summaryRow?.content
      ? `Standing summary:\n${summaryRow.content}\n\n`
      : 'Standing summary: (none yet)\n\n') + `Notes to fold in, oldest first:\n${noteLines}`;

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
  await writeAgentMemorySummary(db, tenantId, agentId, summary);
  await db
    .deleteFrom('agent_memories')
    .where(
      'id',
      'in',
      entries.map((entry) => entry.id)
    )
    .execute();

  logger.info('compacted {folded} memory entr(ies) for agent {agentId}', {
    component: 'worker-agents/memory-compaction',
    agentId,
    tenantId,
    subject: ownerSubject,
    folded: entries.length,
  });
}

/** The lossy last resort, only past the hard cap: drop the oldest rows. */
async function enforceHardCap(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  ownerSubject: string
): Promise<void> {
  const over = await db
    .selectFrom('agent_memories')
    .select(['id'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('kind', '=', 'entry')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(MEMORY_HARD_CAP)
    .execute();
  if (over.length === 0) return;
  await db
    .deleteFrom('agent_memories')
    .where(
      'id',
      'in',
      over.map((row) => row.id)
    )
    .execute();
  logger.warn(
    'memory hard cap: dropped {dropped} oldest entr(ies) for agent {agentId} uncompacted',
    {
      component: 'worker-agents/memory-compaction',
      agentId,
      tenantId,
      subject: ownerSubject,
      dropped: over.length,
    }
  );
}
