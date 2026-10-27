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

import { getDataStore } from '@renkei/db';
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
  ownerSubject: string,
  options: { maxEntries?: number } = {}
): Promise<UserMemory> {
  // A person's memory is theirs alone: sealed under their own key, never
  // under a chat's or a project's — opened by the delegate, the one
  // process that holds that key, in one batch for the page.
  const rows = await getDataStore().userMemory.list(
    ownerSubject,
    (options.maxEntries ?? USER_MEMORY_INJECT_MAX_ENTRIES) + 1
  );
  const opened = await delegateClient().openForSubject(
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
        chatId: row.chatId,
        createdAt: row.createdAt,
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

export async function appendUserMemory(input: {
  ownerSubject: string;
  content: string;
  chatId: string | null;
}): Promise<string | null> {
  const content = clip(input.content.trim(), USER_MEMORY_ENTRY_MAX_CHARS);
  if (!content) return null;
  // Memory is the person's alone: under their user key, never the
  // automation key, so nothing unattended reads it.
  const sealed = await delegateClient().sealForSubject(input.ownerSubject, [content], 'session');
  if (!sealed.ok) return null;
  // A hard cap keeps a long-lived account from growing without bound; the
  // oldest entries go first.
  return getDataStore().userMemory.append({
    ownerSubject: input.ownerSubject,
    content: sealed.val[0],
    chatId: input.chatId,
    keep: USER_MEMORY_HARD_CAP,
  });
}

export async function editUserMemory(
  ownerSubject: string,
  id: string,
  content: string
): Promise<boolean> {
  const clipped = clip(content.trim(), USER_MEMORY_ENTRY_MAX_CHARS);
  if (!clipped) return false;
  const sealed = await delegateClient().sealForSubject(ownerSubject, [clipped], 'session');
  if (!sealed.ok) return false;
  return getDataStore().userMemory.edit(ownerSubject, id, sealed.val[0]);
}

export async function forgetUserMemory(
  ownerSubject: string,
  target: { kind: 'all' } | { kind: 'entries'; ids: string[] }
): Promise<number> {
  if (target.kind === 'entries') {
    const ids = target.ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) return 0;
    return getDataStore().userMemory.forget(ownerSubject, { kind: 'entries', ids });
  }
  return getDataStore().userMemory.forget(ownerSubject, target);
}
