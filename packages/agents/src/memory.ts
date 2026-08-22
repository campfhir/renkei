/**
 * Agent memory — read and append helpers over agent_memories (migration
 * 044). Compaction lives in the agents worker (it needs the agent's LLM);
 * everything here is plain SQL shared by the engine, the sweep, and the
 * owner-facing web views.
 *
 * The context-window guarantee lives in renderAgentMemory: whatever the
 * table holds, a prompt receives at most MEMORY_INJECT_MAX_CHARS —
 * summary first (the compacted long tail), then the newest entries that
 * fit, oldest-to-newest so the model reads them as a timeline. Compaction
 * improves how much history that budget can EXPRESS; it is never what
 * keeps the prompt small.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { contentEncryptionKey, revealContent } from '@renkei/crypto';

/** One memory entry's ceiling — a note, not a document. */
export const MEMORY_ENTRY_MAX_CHARS = 500;
/** The rolling summary's ceiling, enforced at compaction time. */
export const MEMORY_SUMMARY_MAX_CHARS = 3_000;
/** What a run's prompt may carry, total (summary + entries). */
export const MEMORY_INJECT_MAX_CHARS = 4_000;
/** How many verbatim entries a prompt may carry at most. */
export const MEMORY_INJECT_MAX_ENTRIES = 40;
/**
 * Beyond this many entries the agent is overdue for compaction; beyond
 * MEMORY_HARD_CAP the sweep trims oldest entries mechanically (compaction
 * kept failing — bounded storage beats unbounded fidelity).
 */
export const MEMORY_COMPACT_THRESHOLD = 40;
export const MEMORY_KEEP_RECENT = 20;
export const MEMORY_HARD_CAP = 300;

export interface AgentMemoryEntry {
  id: string;
  content: string;
  createdAt: Date;
}

export interface AgentMemory {
  summary: string | null;
  /** Newest first, as read; renderers reverse for chronology. */
  entries: AgentMemoryEntry[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The newest slice of an agent's memory, bounded for injection. */
export async function readAgentMemory(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  limits: { maxEntries?: number } = {}
): Promise<AgentMemory> {
  const maxEntries = limits.maxEntries ?? MEMORY_INJECT_MAX_ENTRIES;
  const rows = await db
    .selectFrom('agent_memories')
    .select(['id', 'kind', 'content', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(maxEntries + 1)
    .execute();

  let summary: string | null = null;
  const entries: AgentMemoryEntry[] = [];
  for (const row of rows) {
    if (row.kind === 'summary') {
      summary = row.content;
    } else if (entries.length < maxEntries) {
      entries.push({ id: row.id, content: row.content, createdAt: row.created_at });
    }
  }
  // The summary sorts by its last-compaction time and may fall outside the
  // newest-N window once entries pile up — fetch it explicitly then.
  if (summary === null) {
    const summaryRow = await db
      .selectFrom('agent_memories')
      .select(['content'])
      .where('tenant_id', '=', tenantId)
      .where('agent_id', '=', agentId)
      .where('kind', '=', 'summary')
      .executeTakeFirst();
    summary = summaryRow?.content ?? null;
  }
  return { summary, entries };
}

/**
 * Append one entry (best-effort callers swallow their own errors; this
 * throws on database failure so tests can see it). Content is clipped to
 * the entry ceiling — memory is notes, never payloads.
 */
export async function appendAgentMemory(
  db: Kysely<DB>,
  input: { tenantId: string; agentId: string; content: string; runId?: string }
): Promise<void> {
  const content = clip(input.content.trim(), MEMORY_ENTRY_MAX_CHARS);
  if (!content) return;
  await db
    .insertInto('agent_memories')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      kind: 'entry',
      content,
      run_id: input.runId ?? null,
    })
    .execute();
}

/** Replace (or create) the agent's one rolling summary. */
export async function writeAgentMemorySummary(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  content: string
): Promise<void> {
  const clipped = clip(content.trim(), MEMORY_SUMMARY_MAX_CHARS);
  await db
    .insertInto('agent_memories')
    .values({
      id: randomUUID(),
      tenant_id: tenantId,
      agent_id: agentId,
      kind: 'summary',
      content: clipped,
    })
    .onConflict((oc) =>
      // The partial unique index (agent_id WHERE kind='summary').
      oc
        .column('agent_id')
        .where('kind', '=', 'summary')
        .doUpdateSet({ content: clipped, updated_at: sql`NOW()` })
    )
    .execute();
}

/** What a run's prompt may carry of the agent's knowledge notes. */
export const AGENT_NOTES_INJECT_MAX_CHARS = 3_000;
export const AGENT_NOTES_INJECT_MAX_NOTES = 10;

/**
 * The agent's OWN knowledge notes (provider 'note' rows this agent wrote
 * via knowledge_create_note — metadata.agentId names it), newest first,
 * rendered under a character budget for run-context injection.
 *
 * Distinct from memory on purpose: memory is the engine's append-only
 * breadcrumb trail (auto-compacted), notes are what the agent DELIBERATELY
 * wrote down and can rewrite through the knowledge tools. A plain select —
 * no embedder — so agents get their notes even in orgs where semantic
 * search is off; chunk rows collapse to one note each (first chunk wins,
 * which carries the opening of the content).
 */
export async function renderAgentKnowledgeNotes(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<string> {
  const keyResult = contentEncryptionKey();
  const contentKey = keyResult.ok ? keyResult.val : null;
  const rows = await db
    .selectFrom('knowledge_chunks')
    .select(['ref_id', 'metadata', 'content', 'source_at'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'note')
    .where(sql<boolean>`metadata ->> 'agentId' = ${agentId}`)
    .orderBy('source_at', 'desc')
    .orderBy('ref_id')
    .limit(AGENT_NOTES_INJECT_MAX_NOTES * 4)
    .execute();

  const lines: string[] = [];
  let spent = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    const hash = row.ref_id.indexOf('#');
    const baseRef = hash > 0 ? row.ref_id.slice(0, hash) : row.ref_id;
    if (seen.has(baseRef)) continue;
    seen.add(baseRef);
    if (seen.size > AGENT_NOTES_INJECT_MAX_NOTES) break;
    const metadata: Record<string, unknown> =
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? { ...row.metadata }
        : {};
    const title = typeof metadata.title === 'string' ? metadata.title : '(untitled)';
    const slash = baseRef.indexOf('/');
    const noteId = slash > 0 ? baseRef.slice(slash + 1) : baseRef;
    // Chunk content is ciphertext at rest (legacy rows pass through).
    const line = `- ${title} [noteId ${noteId}]: ${clip(revealContent(row.content, contentKey), 400)}`;
    if (spent + line.length + 1 > AGENT_NOTES_INJECT_MAX_CHARS) break;
    lines.push(line);
    spent += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * The prompt block a run receives: the summary first, then the newest
 * entries that fit the character budget, oldest-to-newest. Returns '' when
 * the agent remembers nothing yet.
 */
export function renderAgentMemory(memory: AgentMemory): string {
  const lines: string[] = [];
  let spent = 0;
  const push = (line: string): boolean => {
    if (spent + line.length + 1 > MEMORY_INJECT_MAX_CHARS) return false;
    lines.push(line);
    spent += line.length + 1;
    return true;
  };

  if (memory.summary) push(clip(memory.summary, MEMORY_SUMMARY_MAX_CHARS));

  // Newest entries win the leftover budget; render in chronological order.
  const kept: string[] = [];
  for (const entry of memory.entries) {
    const line = `- [${entry.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ${entry.content}`;
    if (spent + line.length + 1 > MEMORY_INJECT_MAX_CHARS) break;
    kept.push(line);
    spent += line.length + 1;
  }
  if (kept.length > 0) {
    lines.push(...kept.reverse());
  }
  return lines.join('\n');
}
