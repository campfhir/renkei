/**
 * Project memory — what a project's chats carry between conversations,
 * shaped exactly like agent memory (packages/agents/src/memory.ts):
 * append-only entries plus one rolling summary, rendered into the prompt
 * under a fixed character budget, newest entries winning the leftover.
 * Content is sealed at rest like every other chat text; who wrote an
 * entry and from which chat is recorded so members can see each other's
 * notes for what they are.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { openText, sealText } from './content-crypto';

export const PROJECT_MEMORY_ENTRY_MAX_CHARS = 500;
export const PROJECT_MEMORY_SUMMARY_MAX_CHARS = 3_000;
export const PROJECT_MEMORY_INJECT_MAX_CHARS = 4_000;
export const PROJECT_MEMORY_INJECT_MAX_ENTRIES = 40;
export const PROJECT_MEMORY_HARD_CAP = 300;

export interface ProjectMemoryEntry {
  id: string;
  content: string;
  authorSubject: string | null;
  chatId: string | null;
  createdAt: Date;
}

export interface ProjectMemory {
  summary: string | null;
  /** Newest first. */
  entries: ProjectMemoryEntry[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function readProjectMemory(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string,
  options: { maxEntries?: number } = {}
): Promise<ProjectMemory> {
  if (!isUuid(projectId)) return { summary: null, entries: [] };
  const rows = await db
    .selectFrom('chat_project_memories')
    .select(['id', 'kind', 'content', 'author_subject', 'chat_id', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('project_id', '=', projectId)
    .orderBy('created_at', 'desc')
    .limit((options.maxEntries ?? PROJECT_MEMORY_INJECT_MAX_ENTRIES) + 1)
    .execute();
  const summary = rows.find((row) => row.kind === 'summary');
  return {
    summary: summary ? openText(summary.content) : null,
    entries: rows
      .filter((row) => row.kind === 'entry')
      .slice(0, options.maxEntries ?? PROJECT_MEMORY_INJECT_MAX_ENTRIES)
      .map((row) => ({
        id: row.id,
        content: openText(row.content),
        authorSubject: row.author_subject,
        chatId: row.chat_id,
        createdAt: row.created_at,
      })),
  };
}

export function renderProjectMemory(memory: ProjectMemory): string | null {
  const lines: string[] = [];
  let spent = 0;
  if (memory.summary) {
    const summary = clip(memory.summary, PROJECT_MEMORY_SUMMARY_MAX_CHARS);
    lines.push(summary);
    spent += summary.length + 1;
  }
  const kept: string[] = [];
  for (const entry of memory.entries) {
    const line = `- [${entry.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ${entry.content}`;
    if (spent + line.length + 1 > PROJECT_MEMORY_INJECT_MAX_CHARS) break;
    kept.push(line);
    spent += line.length + 1;
  }
  lines.push(...kept.reverse());
  return lines.length > 0 ? lines.join('\n') : null;
}

export async function appendProjectMemory(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    projectId: string;
    content: string;
    authorSubject: string;
    chatId: string | null;
  }
): Promise<string | null> {
  const content = clip(input.content.trim(), PROJECT_MEMORY_ENTRY_MAX_CHARS);
  if (!content) return null;
  const sealed = sealText(content);
  if (!sealed.ok) return null;
  const inserted = await db
    .insertInto('chat_project_memories')
    .values({
      tenant_id: input.tenantId,
      project_id: input.projectId,
      kind: 'entry',
      content: sealed.val,
      author_subject: input.authorSubject,
      chat_id: input.chatId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // A hard cap keeps a busy project from growing without bound; the oldest
  // entries go first.
  await sql`
    DELETE FROM chat_project_memories
     WHERE project_id = ${input.projectId} AND kind = 'entry'
       AND id IN (
         SELECT id FROM chat_project_memories
          WHERE project_id = ${input.projectId} AND kind = 'entry'
          ORDER BY created_at DESC OFFSET ${PROJECT_MEMORY_HARD_CAP}
       )
  `.execute(db);
  return inserted.id;
}

export async function forgetProjectMemory(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string,
  target: { kind: 'all' } | { kind: 'entries'; ids: string[] }
): Promise<number> {
  if (!isUuid(projectId)) return 0;
  let query = db
    .deleteFrom('chat_project_memories')
    .where('tenant_id', '=', tenantId)
    .where('project_id', '=', projectId);
  if (target.kind === 'entries') {
    const ids = target.ids.filter(isUuid);
    if (ids.length === 0) return 0;
    query = query.where('id', 'in', ids);
  }
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}
