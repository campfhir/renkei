/**
 * Agent knowledge notes, owner-side: the CRUD the agent page's Knowledge
 * panel uses to hand an agent reference material ("here's the escalation
 * policy — use it every run").
 *
 * Same rows the MCP note tools write (provider 'note', ref
 * `${ownerEmail}/${noteId}`), with `metadata.agentId` stamping which
 * agent's run context they load into and `authoredBy: 'user'` recording
 * that the OWNER wrote this one, not the agent. Ownership stays by
 * construction: every operation derives the ref from the owner's email,
 * and the agentId predicate keeps one agent's panel from touching
 * another's notes.
 *
 * Content reconstruction relies on NOTE_CHUNKING's zero overlap: chunks
 * concatenated in ref order ARE the original text, which is what makes an
 * edit box possible at all.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { contentEncryptionKey, revealContent } from '@renkei/crypto';
import { AGENT_NOTE_SCOPE } from '@renkei/agents/memory';
import {
  resolveEmbeddingProvider,
  ingestObjectChunks,
  deleteObjectChunks,
  noteRefId,
  NOTE_KNOWLEDGE_PROVIDER,
  NOTE_CHUNKING,
} from '@renkei/knowledge';

export const MAX_AGENT_NOTE_CHARS = 50_000;
export const MAX_AGENT_NOTE_TITLE_CHARS = 200;

/** The panel's create/update body — shared by both note routes. */
export function parseNotePayload(body: unknown): { title: string; content: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record: { title?: unknown; content?: unknown } = body;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const content = typeof record.content === 'string' ? record.content : '';
  if (!title || title.length > MAX_AGENT_NOTE_TITLE_CHARS) return null;
  if (!content || content.length > MAX_AGENT_NOTE_CHARS) return null;
  return { title, content };
}

export interface AgentNote {
  noteId: string;
  title: string;
  content: string;
  authoredBy: 'user' | 'agent';
  sourceAt: string | null;
}

export type AgentNoteError = 'DB_ERROR' | 'NOT_FOUND' | 'EMBEDDINGS_OFF' | 'EMBEDDING_FAILED';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function baseRefOf(refId: string): string {
  const hash = refId.indexOf('#');
  return hash > 0 ? refId.slice(0, hash) : refId;
}

/** Every chunk of this agent's notes, owner-scoped, ordered for rebuild. */
async function agentNoteChunks(db: Kysely<DB>, tenantId: string, agentId: string) {
  return db
    .selectFrom('knowledge_chunks')
    .select(['ref_id', 'metadata', 'content', 'source_at'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', NOTE_KNOWLEDGE_PROVIDER)
    .where(sql<boolean>`metadata ->> 'agentId' = ${agentId}`)
    .where(sql<boolean>`metadata ->> 'scope' = ${AGENT_NOTE_SCOPE}`)
    .orderBy('ref_id')
    .execute();
}

/** The agent's notes, newest first, content rebuilt from ordered chunks. */
export async function listAgentNotes(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<AgentNote[]> {
  const rows = await agentNoteChunks(db, tenantId, agentId);
  const keyResult = contentEncryptionKey();
  const contentKey = keyResult.ok ? keyResult.val : null;
  const notes = new Map<string, AgentNote>();
  for (const row of rows) {
    // Each CHUNK is its own ciphertext — decrypt before concatenating.
    const content = revealContent(row.content, contentKey);
    const baseRef = baseRefOf(row.ref_id);
    const slash = baseRef.indexOf('/');
    const noteId = slash > 0 ? baseRef.slice(slash + 1) : baseRef;
    const existing = notes.get(noteId);
    if (existing) {
      // Chunks arrive in ref order (zero overlap), so appending rebuilds
      // the exact original.
      existing.content += content;
      continue;
    }
    const metadata: Record<string, unknown> =
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? { ...row.metadata }
        : {};
    notes.set(noteId, {
      noteId,
      title: typeof metadata.title === 'string' ? metadata.title : '(untitled)',
      content,
      authoredBy: metadata.authoredBy === 'agent' ? 'agent' : 'user',
      sourceAt: row.source_at ? new Date(row.source_at).toISOString() : null,
    });
  }
  return [...notes.values()].sort((a, b) => (b.sourceAt ?? '').localeCompare(a.sourceAt ?? ''));
}

/**
 * Create a note for the agent, embedded synchronously so the very next
 * run carries it. `ownerEmail` is the AGENT OWNER's recorded email — the
 * ref prefix the author-only verifier admits.
 */
export async function createAgentNote(
  db: Kysely<DB>,
  input: { tenantId: string; agentId: string; ownerEmail: string; title: string; content: string }
): Promise<{ noteId: string } | AgentNoteError> {
  const embedder = await resolveEmbeddingProvider(input.tenantId);
  if (!embedder) return 'EMBEDDINGS_OFF';

  const noteId = randomUUID();
  const ingested = await ingestObjectChunks(
    input.tenantId,
    embedder,
    {
      provider: NOTE_KNOWLEDGE_PROVIDER,
      refId: noteRefId(input.ownerEmail, noteId),
      content: input.content,
      metadata: {
        kind: 'note',
        title: input.title,
        authoredBy: 'user',
        agentId: input.agentId,
        // Membership, not provenance — see AGENT_NOTE_SCOPE. Written here
        // because this module IS the deliberate path (the knowledge panel
        // and agent_knowledge_write); knowledge_create_note is not.
        scope: AGENT_NOTE_SCOPE,
      },
      sourceAt: new Date().toISOString(),
    },
    NOTE_CHUNKING
  );
  if (!ingested.ok) {
    return ingested.err.type === 'EMBEDDING_FAILED' ? 'EMBEDDING_FAILED' : 'DB_ERROR';
  }
  return { noteId };
}

/** The note must exist, belong to the owner, AND be this agent's. */
async function noteExists(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  refId: string
): Promise<boolean> {
  const row = await db
    .selectFrom('knowledge_chunks')
    .select(['ref_id'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', NOTE_KNOWLEDGE_PROVIDER)
    .where(sql<boolean>`metadata ->> 'agentId' = ${agentId}`)
    .where(sql<boolean>`metadata ->> 'scope' = ${AGENT_NOTE_SCOPE}`)
    .where((eb) =>
      eb.or([eb('ref_id', '=', refId), eb('ref_id', 'like', `${escapeLike(refId)}#%`)])
    )
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Full replacement — the panel edits title and content together. */
export async function updateAgentNote(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    agentId: string;
    ownerEmail: string;
    noteId: string;
    title: string;
    content: string;
  }
): Promise<'OK' | AgentNoteError> {
  const refId = noteRefId(input.ownerEmail, input.noteId);
  if (!(await noteExists(db, input.tenantId, input.agentId, refId))) return 'NOT_FOUND';

  const embedder = await resolveEmbeddingProvider(input.tenantId);
  if (!embedder) return 'EMBEDDINGS_OFF';

  const ingested = await ingestObjectChunks(
    input.tenantId,
    embedder,
    {
      provider: NOTE_KNOWLEDGE_PROVIDER,
      refId,
      content: input.content,
      // The panel's notes are user-authored by definition; an agent-written
      // note edited here becomes the owner's word.
      metadata: {
        kind: 'note',
        title: input.title,
        authoredBy: 'user',
        agentId: input.agentId,
        scope: AGENT_NOTE_SCOPE,
      },
      sourceAt: new Date().toISOString(),
    },
    NOTE_CHUNKING
  );
  if (!ingested.ok) {
    return ingested.err.type === 'EMBEDDING_FAILED' ? 'EMBEDDING_FAILED' : 'DB_ERROR';
  }
  return 'OK';
}

/**
 * Fork one agent's knowledge notes onto another (the share-copy flow):
 * every note is re-authored under the RECIPIENT's email with fresh
 * noteIds and the target agent's stamp. Content is byte-identical, so the
 * stored EMBEDDINGS, lexical entries and keywords are reused verbatim — no
 * embedder, no model call, and the copy works even in orgs that later
 * switched knowledge off.
 *
 * Chunk suffixes survive via prefix replacement (the base ref embeds an
 * email + uuid, so the prefix cannot collide inside the ref). Memories are
 * deliberately NOT copied anywhere in the copy flow — notes are the
 * agent's reference material, memory is its lived history.
 */
export async function copyAgentNotes(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    sourceAgentId: string;
    targetAgentId: string;
    targetOwnerEmail: string;
  }
): Promise<number> {
  const rows = await db
    .selectFrom('knowledge_chunks')
    .select(['ref_id'])
    .where('tenant_id', '=', input.tenantId)
    .where('provider', '=', NOTE_KNOWLEDGE_PROVIDER)
    .where(sql<boolean>`metadata ->> 'agentId' = ${input.sourceAgentId}`)
    .where(sql<boolean>`metadata ->> 'scope' = ${AGENT_NOTE_SCOPE}`)
    .execute();
  const baseRefs = [...new Set(rows.map((row) => baseRefOf(row.ref_id)))];

  for (const oldBase of baseRefs) {
    const newBase = noteRefId(input.targetOwnerEmail, randomUUID());
    // Every derived column rides along — the vector, the lexical entry
    // and the extracted keywords are all functions of content that is
    // byte-identical here, so copying them is exact and spares the
    // embedder and the model a second pass. Leaving any of them out would
    // hand the recipient a note that search can only half-find.
    await sql`
      INSERT INTO knowledge_chunks
        (id, tenant_id, provider, ref_id, metadata, content, embedding,
         keywords, search_text, source_at)
      SELECT gen_random_uuid(), tenant_id, provider,
             replace(ref_id, ${oldBase}, ${newBase}),
             jsonb_set(metadata, '{agentId}', to_jsonb(${input.targetAgentId}::text)),
             content, embedding, keywords, search_text, source_at
      FROM knowledge_chunks
      WHERE tenant_id = ${input.tenantId}
        AND provider = ${NOTE_KNOWLEDGE_PROVIDER}
        AND (ref_id = ${oldBase} OR ref_id LIKE ${oldBase} || '#%')
    `.execute(db);
  }
  return baseRefs.length;
}

export async function deleteAgentNote(
  db: Kysely<DB>,
  input: { tenantId: string; agentId: string; ownerEmail: string; noteId: string }
): Promise<'OK' | AgentNoteError> {
  const refId = noteRefId(input.ownerEmail, input.noteId);
  if (!(await noteExists(db, input.tenantId, input.agentId, refId))) return 'NOT_FOUND';
  const deleted = await deleteObjectChunks(input.tenantId, NOTE_KNOWLEDGE_PROVIDER, refId);
  return deleted.ok ? 'OK' : 'DB_ERROR';
}

/**
 * Delete several notes, or every note this agent has.
 *
 * Reports per-note outcomes rather than failing the batch: with a
 * multi-select the useful answer is "these went, that one did not", and a
 * caller who deleted a note in another tab should not have the rest refused
 * on their behalf. NOT_FOUND is therefore counted, not raised.
 *
 * `all` re-reads the list rather than trusting ids from the client, so a
 * purge cannot be aimed at anything outside this agent.
 */
export async function deleteAgentNotes(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    agentId: string;
    ownerEmail: string;
    noteIds?: string[];
    all?: boolean;
  }
): Promise<{ deleted: number; missing: number; failed: number }> {
  const ids = input.all
    ? (await listAgentNotes(db, input.tenantId, input.agentId)).map((note) => note.noteId)
    : (input.noteIds ?? []);

  let deleted = 0;
  let missing = 0;
  let failed = 0;
  for (const noteId of ids) {
    const outcome = await deleteAgentNote(db, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      ownerEmail: input.ownerEmail,
      noteId,
    });
    if (outcome === 'OK') deleted += 1;
    else if (outcome === 'NOT_FOUND') missing += 1;
    else failed += 1;
  }
  return { deleted, missing, failed };
}
