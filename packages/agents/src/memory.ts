/**
 * Agent memory — read and append helpers over agent_memories (migration
 * 044). Compaction lives in the agents worker (it needs the agent's LLM);
 * everything here is plain SQL shared by the engine, the sweep, and the
 * owner-facing web views.
 *
 * Content is SEALED: every entry and the summary are `uenc1:` envelopes
 * under the agent owner's automation key (docs/delegate-key-design.md),
 * sealed and opened by the delegate — the same key the owner's agent runs
 * and connector credentials live under, so a run reads its memory
 * unattended while a database copy shows nothing of what the agent
 * remembered. The owner is read off the `agents` row, so the callers'
 * shape (tenant, agent) is unchanged. A row still in plaintext — from
 * before sealing, until the rekey sweep (`pnpm --filter
 * @renkei/worker-agents rekey-agent-memories`) has moved it — is read as
 * it is, so nothing goes dark on deploy; nothing new is ever written in
 * the clear.
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
import { contentEncryptionKey, isUserSealed, revealContent } from '@renkei/crypto';
import { delegateClient, type KeyOpError } from '@renkei/delegate-client';

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
  /** When the summary was last compacted; null without a summary. */
  summaryUpdatedAt: Date | null;
  /** Newest first, as read; renderers reverse for chronology. */
  entries: AgentMemoryEntry[];
  /**
   * Set when the owner's key is not available to open the sealed rows
   * (not delegated, not enrolled, the delegate down): `summary` is null
   * and `entries` empty, and a view says why instead of showing nothing.
   */
  unavailable: KeyOpError | null;
}

/** The agent's owner — whose automation key the memory is sealed under. */
async function ownerSubjectOf(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<string | null> {
  const row = await db
    .selectFrom('agents')
    .select('owner_subject')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', agentId)
    .executeTakeFirst();
  return row?.owner_subject ?? null;
}

/**
 * Stored contents opened as the owner, in one delegate call: a sealed
 * value through the delegate, a plaintext row (pre-sealing) as it is.
 * Fails as a whole when the owner's key is not available — a memory half
 * read would be a memory the run acts on without knowing it is partial.
 */
async function openContents(
  tenantId: string,
  ownerSubject: string,
  stored: string[]
): Promise<{ ok: true; contents: string[] } | { ok: false; reason: KeyOpError }> {
  const sealedIndexes = stored.flatMap((value, index) => (isUserSealed(value) ? [index] : []));
  if (sealedIndexes.length === 0) return { ok: true, contents: stored };
  const opened = await delegateClient().openForSubject(
    tenantId,
    ownerSubject,
    sealedIndexes.map((index) => stored[index])
  );
  if (!opened.ok) return { ok: false, reason: opened.err.type };
  const contents = [...stored];
  sealedIndexes.forEach((index, position) => {
    const plaintext = opened.val[position];
    if (plaintext === null || plaintext === undefined) {
      contents[index] = '[memory entry unavailable: it did not open under the owner\u2019s key]';
    } else {
      contents[index] = plaintext;
    }
  });
  return { ok: true, contents };
}

/** One value sealed under the owner's automation key, or the delegate's verdict. */
async function sealContent(
  tenantId: string,
  ownerSubject: string,
  content: string
): Promise<{ ok: true; sealed: string } | { ok: false; reason: KeyOpError }> {
  const sealed = await delegateClient().sealForSubject(
    tenantId,
    ownerSubject,
    [content],
    'automation'
  );
  if (!sealed.ok) return { ok: false, reason: sealed.err.type };
  return { ok: true, sealed: sealed.val[0] };
}

const NO_MEMORY: AgentMemory = {
  summary: null,
  summaryUpdatedAt: null,
  entries: [],
  unavailable: null,
};

/** Entry ids are uuids; see forgetAgentMemory for why the shape matters. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    .select(['id', 'kind', 'content', 'created_at', 'updated_at'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(maxEntries + 1)
    .execute();

  let summaryRow = rows.find((row) => row.kind === 'summary') ?? null;
  // The summary sorts by its last-compaction time and may fall outside the
  // newest-N window once entries pile up — fetch it explicitly then.
  if (summaryRow === null) {
    summaryRow =
      (await db
        .selectFrom('agent_memories')
        .select(['id', 'kind', 'content', 'created_at', 'updated_at'])
        .where('tenant_id', '=', tenantId)
        .where('agent_id', '=', agentId)
        .where('kind', '=', 'summary')
        .executeTakeFirst()) ?? null;
  }
  const entryRows = rows.filter((row) => row.kind === 'entry').slice(0, maxEntries);
  if (summaryRow === null && entryRows.length === 0) return { ...NO_MEMORY };

  const owner = await ownerSubjectOf(db, tenantId, agentId);
  if (owner === null) return { ...NO_MEMORY, unavailable: 'NO_USER_KEY' };
  const opened = await openContents(tenantId, owner, [
    ...(summaryRow ? [summaryRow.content] : []),
    ...entryRows.map((row) => row.content),
  ]);
  if (!opened.ok) return { ...NO_MEMORY, unavailable: opened.reason };
  const offset = summaryRow ? 1 : 0;
  return {
    summary: summaryRow ? opened.contents[0] : null,
    summaryUpdatedAt: summaryRow ? summaryRow.updated_at : null,
    entries: entryRows.map((row, index) => ({
      id: row.id,
      content: opened.contents[index + offset],
      createdAt: row.created_at,
    })),
    unavailable: null,
  };
}

/**
 * Append one entry (best-effort callers swallow their own errors; this
 * throws on database failure so tests can see it). Content is clipped to
 * the entry ceiling — memory is notes, never payloads.
 *
 * An entry identical to one the agent already holds is not written again
 * (`inserted: false`): a step that remembers the same fact on every run
 * would otherwise fill the prompt budget with one line repeated. A plain
 * select-before-insert rather than a unique index, because existing
 * tables already hold duplicates and the only race — two concurrent runs
 * remembering the same thing — is benign and folded by compaction.
 */
export async function appendAgentMemory(
  db: Kysely<DB>,
  input: { tenantId: string; agentId: string; content: string; runId?: string }
): Promise<{ inserted: boolean }> {
  const content = clip(input.content.trim(), MEMORY_ENTRY_MAX_CHARS);
  if (!content) return { inserted: false };
  const owner = await ownerSubjectOf(db, input.tenantId, input.agentId);
  if (owner === null) return { inserted: false };
  // The duplicate check reads the agent's entries back through the owner's
  // key: two seals of one text differ byte for byte, so equality has to be
  // judged on the plaintext. Bounded by MEMORY_HARD_CAP, one delegate call.
  const existing = await readAgentMemory(db, input.tenantId, input.agentId, {
    maxEntries: MEMORY_HARD_CAP,
  });
  if (existing.unavailable !== null) return { inserted: false };
  if (existing.entries.some((entry) => entry.content === content)) return { inserted: false };
  const sealed = await sealContent(input.tenantId, owner, content);
  if (!sealed.ok) return { inserted: false };
  await db
    .insertInto('agent_memories')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      kind: 'entry',
      content: sealed.sealed,
      run_id: input.runId ?? null,
    })
    .execute();
  return { inserted: true };
}

/** Replace (or create) the agent's one rolling summary. */
export async function writeAgentMemorySummary(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  content: string
): Promise<void> {
  const clipped = clip(content.trim(), MEMORY_SUMMARY_MAX_CHARS);
  const owner = await ownerSubjectOf(db, tenantId, agentId);
  if (owner === null) throw new Error('agent not found: no owner to seal the summary for');
  const sealed = await sealContent(tenantId, owner, clipped);
  if (!sealed.ok) throw new Error(`memory summary could not be sealed: ${sealed.reason}`);
  await db
    .insertInto('agent_memories')
    .values({
      id: randomUUID(),
      tenant_id: tenantId,
      agent_id: agentId,
      kind: 'summary',
      content: sealed.sealed,
    })
    .onConflict((oc) =>
      // The partial unique index (agent_id WHERE kind='summary').
      oc
        .column('agent_id')
        .where('kind', '=', 'summary')
        .doUpdateSet({ content: sealed.sealed, updated_at: sql`NOW()` })
    )
    .execute();
}

/**
 * Stored memory contents opened as the owner — for the compaction sweep,
 * which reads the rows it is about to fold directly. Plaintext rows pass
 * through; a key that is not available fails the batch (the sweep tries
 * again next pass).
 */
export async function openAgentMemoryContents(
  tenantId: string,
  ownerSubject: string,
  stored: string[]
): Promise<{ ok: true; contents: string[] } | { ok: false; reason: KeyOpError }> {
  return openContents(tenantId, ownerSubject, stored);
}

/** What a run's prompt may carry of the agent's knowledge notes. */
/**
 * The membership marker on a knowledge chunk that belongs to an agent.
 *
 * Provenance and membership used to be the same field. `knowledge_create_note`
 * stamps `agentId` whenever an agent calls it — reasonable as provenance,
 * "this org note was written by that agent" — and the injection query read
 * the same field as "inject this into that agent's every run". So a step
 * whose tool was knowledge_create_note silently and permanently grew its own
 * agent's prompt, which nobody chose.
 *
 * `scope` says membership and nothing else. Only the deliberate paths set it:
 * the knowledge panel and agent_knowledge_write, both via agent-notes.ts.
 */
export const AGENT_NOTE_SCOPE = 'agent';

export const AGENT_NOTES_INJECT_MAX_CHARS = 3_000;
/** At or under this, a note's whole body rides the index — see below. */
const SHORT_NOTE_CHARS = 160;
/**
 * How many notes the injected INDEX may name.
 *
 * Bodies used to be injected — ten notes clipped to 400 characters each. That
 * fails quietly as knowledge grows: the ten are chosen by recency, so an
 * agent with sixty notes silently gets whichever were written last rather
 * than whichever matter, and the run has no way to know the rest exist.
 *
 * Titles and ids are a fraction of the size, so five times as many fit the
 * same budget, and the run can see EVERYTHING it holds and fetch what it
 * needs with agent_knowledge_list. An index that names all sixty beats ten
 * arbitrary bodies.
 */
export const AGENT_NOTES_INJECT_MAX_NOTES = 50;

/**
 * The agent's OWN knowledge notes (provider 'note' rows this agent wrote
 * via knowledge_create_note — metadata.agentId names it), newest first,
 * rendered under a character budget for run-context injection.
 *
 * Distinct from memory on purpose: memory is what steps chose to remember
 * through finish_step, one line at a time (auto-compacted); notes are what
 * the agent DELIBERATELY wrote down and can rewrite through the knowledge
 * tools. A plain select —
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
    .where(sql<boolean>`metadata ->> 'scope' = ${AGENT_NOTE_SCOPE}`)
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
    // An index line: what the note is and how to fetch it, not what it says.
    // A short note still carries a preview, because for those the preview IS
    // the note and a second call to read forty characters is pure latency.
    const body = revealContent(row.content, contentKey);
    const preview = body.length <= SHORT_NOTE_CHARS ? `: ${body}` : '';
    const line = `- ${title} [noteId ${noteId}]${preview}`;
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

/**
 * What an agent currently holds, without reading any of it back — the
 * numbers a "forget everything?" dry run needs. readAgentMemory would
 * answer the entry question too, but only up to its own limit, and a
 * confirmation that says "40 entries" when there are 300 is worse than no
 * confirmation at all.
 */
export async function countAgentMemory(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<{ entries: number; hasSummary: boolean }> {
  const rows = await db
    .selectFrom('agent_memories')
    .select(['kind', ({ fn }) => fn.countAll<string>().as('count')])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .groupBy('kind')
    .execute();
  let entries = 0;
  let hasSummary = false;
  for (const row of rows) {
    if (row.kind === 'summary') hasSummary = Number(row.count) > 0;
    else entries += Number(row.count);
  }
  return { entries, hasSummary };
}

/** What forgetAgentMemory was asked to drop. */
export type AgentMemoryTarget =
  /** Everything: entries and the rolling summary. */
  | { kind: 'all' }
  /** The rolling summary only — entries stay. */
  | { kind: 'summary' }
  /** Named entries only, by the ids readAgentMemory returns. */
  | { kind: 'entries'; entryIds: string[] };

export interface AgentMemoryForgetResult {
  entriesDeleted: number;
  summaryCleared: boolean;
  /** Ids that matched no entry of this agent — reported, never fatal. */
  missingIds: string[];
}

/**
 * Delete memory rows, tenant- and agent-scoped.
 *
 * The scoping is the whole safety story: every predicate carries both
 * tenant_id and agent_id, so an id belonging to another agent (or another
 * tenant) simply matches nothing and comes back in `missingIds`. Callers
 * report that rather than failing — same posture as the note tools, where
 * one bad id does not void the rest.
 *
 * Deleting is deliberately DUMB: no tombstone, no summary rewrite. The
 * summary is compaction's output, so dropping entries it already folded in
 * leaves those facts in the summary; a caller that wants a genuinely clean
 * slate passes { kind: 'all' }.
 */
export async function forgetAgentMemory(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  target: AgentMemoryTarget
): Promise<AgentMemoryForgetResult> {
  if (target.kind === 'all') {
    const before = await countAgentMemory(db, tenantId, agentId);
    await db
      .deleteFrom('agent_memories')
      .where('tenant_id', '=', tenantId)
      .where('agent_id', '=', agentId)
      .execute();
    return {
      entriesDeleted: before.entries,
      summaryCleared: before.hasSummary,
      missingIds: [],
    };
  }

  if (target.kind === 'summary') {
    const deleted = await db
      .deleteFrom('agent_memories')
      .where('tenant_id', '=', tenantId)
      .where('agent_id', '=', agentId)
      .where('kind', '=', 'summary')
      .executeTakeFirst();
    return {
      entriesDeleted: 0,
      summaryCleared: Number(deleted.numDeletedRows ?? 0) > 0,
      missingIds: [],
    };
  }

  const ids = [...new Set(target.entryIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { entriesDeleted: 0, summaryCleared: false, missingIds: [] };

  // A malformed id never reaches the query: `id` is a uuid column, so
  // Postgres answers a 22P02 for the cast and ONE typo'd id would take the
  // whole batch down. Shape-checking here makes it what it actually is —
  // an id that matches nothing.
  const wellFormed = ids.filter((id) => UUID_RE.test(id));
  const malformed = ids.filter((id) => !UUID_RE.test(id));
  if (wellFormed.length === 0) {
    return { entriesDeleted: 0, summaryCleared: false, missingIds: malformed };
  }

  // Which of them are actually this agent's, read before the delete so the
  // caller can name the ones that were not.
  const found = await db
    .selectFrom('agent_memories')
    .select(['id'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('kind', '=', 'entry')
    .where('id', 'in', wellFormed)
    .execute();
  const foundIds = found.map((row) => row.id);
  if (foundIds.length > 0) {
    await db
      .deleteFrom('agent_memories')
      .where('tenant_id', '=', tenantId)
      .where('agent_id', '=', agentId)
      .where('kind', '=', 'entry')
      .where('id', 'in', foundIds)
      .execute();
  }
  const foundSet = new Set(foundIds);
  return {
    entriesDeleted: foundIds.length,
    summaryCleared: false,
    // Original order, so a caller's report reads back in the order it asked.
    missingIds: ids.filter((id) => !foundSet.has(id)),
  };
}
