/**
 * User memory — what a person's chats carry between conversations, shaped
 * exactly like project memory (memory.ts) and agent memory
 * (packages/agents/src/memory.ts): append-only entries plus one rolling
 * summary, rendered into the prompt under a fixed character budget, newest
 * entries winning the leftover. Content is sealed at rest like every other
 * chat text. Scoped to `owner_subject` rather than a project, so it is the
 * same across every chat the person owns — except a chat inside a project,
 * which reads and writes the project's own memory instead (chatLocalTools
 * decides which set a turn gets; this module has no opinion).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { delegateClient } from '@renkei/delegate-client';
import { unavailableMarker } from './content-crypto';
import { unavailableReasonOf } from './chat-keys';

export const USER_MEMORY_ENTRY_MAX_CHARS = 500;
export const USER_MEMORY_SUMMARY_MAX_CHARS = 3_000;
export const USER_MEMORY_INJECT_MAX_CHARS = 4_000;
export const USER_MEMORY_INJECT_MAX_ENTRIES = 40;
export const USER_MEMORY_HARD_CAP = 300;

export interface UserMemoryEntry {
  id: string;
  content: string;
  chatId: string | null;
  createdAt: Date;
}

export interface UserMemory {
  summary: string | null;
  /** Newest first. */
  entries: UserMemoryEntry[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function readUserMemory(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  options: { maxEntries?: number } = {}
): Promise<UserMemory> {
  // A person's memory is theirs alone: sealed under their own key, never
  // under a chat's or a project's — opened by the delegate, the one
  // process that holds that key, in one batch for the page.
  const rows = await db
    .selectFrom('chat_user_memories')
    .select(['id', 'kind', 'content', 'chat_id', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .orderBy('created_at', 'desc')
    .limit((options.maxEntries ?? USER_MEMORY_INJECT_MAX_ENTRIES) + 1)
    .execute();
  const opened = await delegateClient().openForSubject(
    tenantId,
    ownerSubject,
    rows.map((row) => row.content)
  );
  const textAt = (index: number): string => {
    if (!opened.ok) return unavailableMarker(unavailableReasonOf(opened.err.type));
    return opened.val[index] ?? unavailableMarker('failed');
  };
  const summaryIndex = rows.findIndex((row) => row.kind === 'summary');
  return {
    summary: summaryIndex >= 0 ? textAt(summaryIndex) : null,
    entries: rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.kind === 'entry')
      .slice(0, options.maxEntries ?? USER_MEMORY_INJECT_MAX_ENTRIES)
      .map(({ row, index }) => ({
        id: row.id,
        content: textAt(index),
        chatId: row.chat_id,
        createdAt: row.created_at,
      })),
  };
}

export function renderUserMemory(memory: UserMemory): string | null {
  const lines: string[] = [];
  let spent = 0;
  if (memory.summary) {
    const summary = clip(memory.summary, USER_MEMORY_SUMMARY_MAX_CHARS);
    lines.push(summary);
    spent += summary.length + 1;
  }
  const kept: string[] = [];
  for (const entry of memory.entries) {
    const line = `- [${entry.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ${entry.content}`;
    if (spent + line.length + 1 > USER_MEMORY_INJECT_MAX_CHARS) break;
    kept.push(line);
    spent += line.length + 1;
  }
  lines.push(...kept.reverse());
  return lines.length > 0 ? lines.join('\n') : null;
}

export async function appendUserMemory(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    ownerSubject: string;
    content: string;
    chatId: string | null;
  }
): Promise<string | null> {
  const content = clip(input.content.trim(), USER_MEMORY_ENTRY_MAX_CHARS);
  if (!content) return null;
  // Memory is the person's alone: under their user key, never the
  // automation key, so nothing unattended reads it.
  const sealed = await delegateClient().sealForSubject(
    input.tenantId,
    input.ownerSubject,
    [content],
    'session'
  );
  if (!sealed.ok) return null;
  const inserted = await db
    .insertInto('chat_user_memories')
    .values({
      tenant_id: input.tenantId,
      owner_subject: input.ownerSubject,
      kind: 'entry',
      content: sealed.val[0],
      chat_id: input.chatId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // A hard cap keeps a long-lived account from growing without bound; the
  // oldest entries go first.
  await sql`
    DELETE FROM chat_user_memories
     WHERE tenant_id = ${input.tenantId} AND owner_subject = ${input.ownerSubject} AND kind = 'entry'
       AND id IN (
         SELECT id FROM chat_user_memories
          WHERE tenant_id = ${input.tenantId} AND owner_subject = ${input.ownerSubject} AND kind = 'entry'
          ORDER BY created_at DESC OFFSET ${USER_MEMORY_HARD_CAP}
       )
  `.execute(db);
  return inserted.id;
}

export async function editUserMemory(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  id: string,
  content: string
): Promise<boolean> {
  const clipped = clip(content.trim(), USER_MEMORY_ENTRY_MAX_CHARS);
  if (!clipped) return false;
  const sealed = await delegateClient().sealForSubject(
    tenantId,
    ownerSubject,
    [clipped],
    'session'
  );
  if (!sealed.ok) return false;
  const result = await db
    .updateTable('chat_user_memories')
    .set({ content: sealed.val[0], updated_at: sql<Date>`NOW()` })
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', id)
    .where('kind', '=', 'entry')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function forgetUserMemory(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  target: { kind: 'all' } | { kind: 'entries'; ids: string[] }
): Promise<number> {
  let query = db
    .deleteFrom('chat_user_memories')
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject);
  if (target.kind === 'entries') {
    const ids = target.ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) return 0;
    query = query.where('id', 'in', ids);
  }
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}
