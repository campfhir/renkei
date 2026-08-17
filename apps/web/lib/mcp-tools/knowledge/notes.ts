/**
 * Authored knowledge notes — the write surface of the knowledge connector.
 *
 * Users and agents persist their own knowledge here (`provider: 'note'`,
 * @renkei/knowledge note.ts). Two properties do all the security work:
 *
 *  - OWNERSHIP BY CONSTRUCTION: every tool derives the ref from the
 *    CALLER's recorded email plus a noteId — there is no provider or ref
 *    argument — so pipeline-ingested knowledge (jira, confluence,
 *    microsoft, webex, zoom) is unreachable, and so is any other author's
 *    note. Nothing here checks "may I touch this row"; the row that could
 *    be touched is always the caller's own.
 *  - AUTHOR-ONLY READ: the note verifier admits exactly the ref-prefix
 *    owner, so a note never travels further than the person who wrote it
 *    (or whose agent wrote it — agents act as their owner).
 *
 * Writes embed SYNCHRONOUSLY (resolveEmbeddingProvider + ingest): the
 * caller — often an agent mid-run — needs to know the note is searchable
 * now, and needs the error if it is not. The embedding queue exists for
 * webhook-volume ingest; a note is one small object. Registration stays
 * I/O-free (registry contract): all work happens inside handlers.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import {
  resolveEmbeddingProvider,
  ingestObjectChunks,
  deleteObjectChunks,
  noteRefId,
  NOTE_KNOWLEDGE_PROVIDER,
  NOTE_CHUNKING,
} from '@renkei/knowledge';
import type { MCPToolContext } from '../common';
import { logger } from '@/lib/logger';

/** Generous for notes, far below anything that would strain the embedder. */
const MAX_NOTE_CHARS = 50_000;
const MAX_TITLE_CHARS = 200;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const NO_EMAIL =
  'Renkei has no email on record for your identity, so your notes cannot be ' +
  'addressed. Sign in to Renkei again to refresh it.';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `owner/noteId` and `owner/noteId#0002` → `noteId`. */
function noteIdOfRefId(refId: string, ownerEmail: string): string {
  const bare = refId.slice(ownerEmail.length + 1);
  const hash = bare.indexOf('#');
  return hash > 0 ? bare.slice(0, hash) : bare;
}

/** One stored chunk of the note, enough to prove existence and read metadata. */
async function findNoteChunk(
  tenantId: string,
  refId: string
): Promise<{ metadata: unknown } | null | 'DB_ERROR'> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'DB_ERROR';
  const row = await dbResult.val
    .selectFrom('knowledge_chunks')
    .select(['metadata'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', NOTE_KNOWLEDGE_PROVIDER)
    .where((eb) =>
      eb.or([eb('ref_id', '=', refId), eb('ref_id', 'like', `${escapeLike(refId)}#%`)])
    )
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

export function registerKnowledgeNoteTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'knowledge_create_note',
    {
      title: 'Knowledge · Act — Create a personal note',
      description:
        'Persist a note into your own knowledge. Notes are private to you: only you (and ' +
        'agents running on your behalf) can find them via search_knowledge, under the ' +
        '`notes` source. Returns the noteId for later updates.',
      // Writes to Renkei's own index, never to a provider — but it is a
      // write, so readOnlyHint is false: org read-only mode disables it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        title: z.string().min(1).max(MAX_TITLE_CHARS).describe('Short human title for the note'),
        content: z.string().min(1).max(MAX_NOTE_CHARS).describe('The note body (plain text)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const userEmail = context.userEmail;
      if (!userEmail) return errText(NO_EMAIL);
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!title || !content) return errText('Both title and content are required.');

      const embedder = await resolveEmbeddingProvider(context.tenantId);
      if (!embedder) {
        return errText('The knowledge layer is not configured for this organization.');
      }

      const noteId = randomUUID();
      const ingested = await ingestObjectChunks(
        context.tenantId,
        embedder,
        {
          provider: NOTE_KNOWLEDGE_PROVIDER,
          refId: noteRefId(userEmail, noteId),
          content,
          metadata: {
            kind: 'note',
            title,
            authoredBy: context.agent ? 'agent' : 'user',
            ...(context.agent ? { agentId: context.agent.agentId } : {}),
          },
          // A note's own date is its last edit — that is what recency browse
          // and date filters should sort it by.
          sourceAt: new Date().toISOString(),
        },
        NOTE_CHUNKING
      );
      if (!ingested.ok) {
        return errText(
          ingested.err.type === 'EMBEDDING_FAILED'
            ? 'The embedding provider could not process the note; nothing was saved.'
            : 'The knowledge store could not be written.'
        );
      }

      logger.info('knowledge_create_note saved', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        noteId,
        authoredBy: context.agent ? 'agent' : 'user',
      });
      return textResult(`Note saved. noteId: ${noteId}`);
    }
  );

  server.registerTool(
    'knowledge_update_note',
    {
      title: 'Knowledge · Act — Update a personal note',
      description:
        'Update the title and/or content of one of YOUR notes (created with ' +
        'knowledge_create_note). Notes ingested from connected tools cannot be modified.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        noteId: z.string().min(1).describe('The noteId returned by knowledge_create_note'),
        title: z.string().min(1).max(MAX_TITLE_CHARS).optional().describe('New title'),
        content: z.string().min(1).max(MAX_NOTE_CHARS).optional().describe('New body'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const userEmail = context.userEmail;
      if (!userEmail) return errText(NO_EMAIL);
      const noteId = typeof args.noteId === 'string' ? args.noteId.trim() : '';
      if (!noteId) return errText('noteId is required.');
      const title = typeof args.title === 'string' ? args.title.trim() : undefined;
      const content = typeof args.content === 'string' ? args.content : undefined;
      if (title === undefined && content === undefined) {
        return errText('Nothing to update — pass a new title, content, or both.');
      }

      const refId = noteRefId(userEmail, noteId);
      const existing = await findNoteChunk(context.tenantId, refId);
      if (existing === 'DB_ERROR') return errText('Database unavailable.');
      if (!existing) return errText(`No note of yours has id ${noteId}.`);
      const existingMeta: Record<string, unknown> =
        typeof existing.metadata === 'object' &&
        existing.metadata !== null &&
        !Array.isArray(existing.metadata)
          ? { ...existing.metadata }
          : {};

      if (content === undefined) {
        // Title-only: rewrite metadata in place across the note's chunks.
        // Re-chunking from stored chunks would be lossy (overlap regions),
        // and the embedding keys off content, which is unchanged.
        const dbResult = getDatabase();
        if (!dbResult.ok) return errText('Database unavailable.');
        await dbResult.val
          .updateTable('knowledge_chunks')
          .set({ metadata: sql`metadata || jsonb_build_object('title', ${title}::text)` })
          .where('tenant_id', '=', context.tenantId)
          .where('provider', '=', NOTE_KNOWLEDGE_PROVIDER)
          .where((eb) =>
            eb.or([eb('ref_id', '=', refId), eb('ref_id', 'like', `${escapeLike(refId)}#%`)])
          )
          .execute();
        return textResult('Note title updated.');
      }

      const embedder = await resolveEmbeddingProvider(context.tenantId);
      if (!embedder) {
        return errText('The knowledge layer is not configured for this organization.');
      }
      // chunk/chunkCount are re-derived by the ingest; carry everything else
      // (authoredBy/agentId — creation provenance survives edits).
      const { chunk: _chunk, chunkCount: _chunkCount, ...carriedMeta } = existingMeta;
      const ingested = await ingestObjectChunks(
        context.tenantId,
        embedder,
        {
          provider: NOTE_KNOWLEDGE_PROVIDER,
          refId,
          content,
          metadata: {
            ...carriedMeta,
            kind: 'note',
            title: title ?? (typeof existingMeta.title === 'string' ? existingMeta.title : ''),
          },
          sourceAt: new Date().toISOString(),
        },
        NOTE_CHUNKING
      );
      if (!ingested.ok) {
        return errText(
          ingested.err.type === 'EMBEDDING_FAILED'
            ? 'The embedding provider could not process the note; the previous version was removed but the new one was not saved. Retry to restore it.'
            : 'The knowledge store could not be written.'
        );
      }
      return textResult('Note updated.');
    }
  );

  server.registerTool(
    'knowledge_delete_note',
    {
      title: 'Knowledge · Act — Delete a personal note',
      description: 'Delete one of YOUR notes permanently.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        noteId: z.string().min(1).describe('The noteId to delete'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const userEmail = context.userEmail;
      if (!userEmail) return errText(NO_EMAIL);
      const noteId = typeof args.noteId === 'string' ? args.noteId.trim() : '';
      if (!noteId) return errText('noteId is required.');

      const refId = noteRefId(userEmail, noteId);
      const existing = await findNoteChunk(context.tenantId, refId);
      if (existing === 'DB_ERROR') return errText('Database unavailable.');
      if (!existing) return errText(`No note of yours has id ${noteId}.`);

      const deleted = await deleteObjectChunks(context.tenantId, NOTE_KNOWLEDGE_PROVIDER, refId);
      if (!deleted.ok) return errText('The knowledge store could not be written.');
      return textResult('Note deleted.');
    }
  );

  server.registerTool(
    'knowledge_list_notes',
    {
      title: 'Knowledge · Read — List your notes',
      description:
        'List YOUR notes (newest first) with their noteIds — the ids knowledge_update_note ' +
        'and knowledge_delete_note take.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('Max notes (default 20)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const userEmail = context.userEmail;
      if (!userEmail) return errText(NO_EMAIL);
      const limit =
        typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 20;

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const prefix = `${userEmail.toLowerCase()}/`;
      const rows = await dbResult.val
        .selectFrom('knowledge_chunks')
        .select(['ref_id', 'metadata', 'source_at'])
        .where('tenant_id', '=', context.tenantId)
        .where('provider', '=', NOTE_KNOWLEDGE_PROVIDER)
        .where('ref_id', 'like', `${escapeLike(prefix)}%`)
        .orderBy('source_at', 'desc')
        .execute();

      // Collapse chunk suffixes to one row per note, first chunk wins.
      const seen = new Map<string, { title: string; authoredBy: string; sourceAt: string }>();
      for (const row of rows) {
        const noteId = noteIdOfRefId(row.ref_id, userEmail.toLowerCase());
        if (seen.has(noteId)) continue;
        const meta: Record<string, unknown> =
          typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
            ? { ...row.metadata }
            : {};
        seen.set(noteId, {
          title: typeof meta.title === 'string' ? meta.title : '(untitled)',
          authoredBy: meta.authoredBy === 'agent' ? 'agent' : 'user',
          sourceAt: row.source_at ? new Date(row.source_at).toISOString() : '',
        });
        if (seen.size >= limit) break;
      }

      if (seen.size === 0) return textResult('You have no notes yet.');
      const lines = [`${seen.size} note(s), newest first:`];
      for (const [noteId, note] of seen) {
        lines.push(
          '',
          `- ${note.title}${note.sourceAt ? ` — ${note.sourceAt}` : ''}` +
            `${note.authoredBy === 'agent' ? ' — written by an agent' : ''}`,
          `  noteId: ${noteId}`
        );
      }
      return textResult(lines.join('\n'));
    }
  );
}
