/**
 * user_memory_* — the same `chat_user_memories` a chat's own
 * chat_memory_remember/forget/list write and read (apps/web/lib/chat/
 * user-memory-tools.ts), reachable from the general MCP surface so an
 * agent run can read and add to what a person's chats remember about
 * them too. Owner-scoped exactly like cards (`../cards`): `context.subject`
 * IS the key, no agent-access-grant indirection, because there is no
 * sharing concept for a person's own memory — for an agent run,
 * `context.subject` already names the run's owner (common.ts), so this
 * needs no extra plumbing to reach the right rows.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import {
  appendUserMemory,
  countUserMemory,
  forgetUserMemory,
  readUserMemory,
} from '@/lib/chat/user-memory';

/** The connector key the memory capabilities register under. */
export const USER_MEMORY_CONNECTOR = 'user-memory';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const NO_SUBJECT = 'This caller has no recorded identity, so it cannot own memory.';

function entryCount(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

export function registerUserMemoryTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'user_memory_list',
    {
      title: 'Memory · Read — What is remembered about you',
      description:
        'List what YOUR chats have remembered about you across every chat you own — the ' +
        'rolling summary and every entry, newest first. A project keeps separate memory of ' +
        'its own, not included here. Returns entry ids for user_memory_forget.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const memory = await readUserMemory(dbResult.val, context.tenantId, context.subject, {
        maxEntries: 100,
      });
      if (!memory.summary && memory.entries.length === 0) {
        return textResult('Nothing remembered yet.');
      }
      const lines: string[] = [];
      if (memory.summary) lines.push('Summary:', memory.summary, '');
      if (memory.entries.length > 0) {
        lines.push(`Entries (${memory.entries.length}, newest first):`);
        for (const entry of memory.entries) {
          lines.push(
            `- [${entry.createdAt.toISOString()}] (entryId: ${entry.id}) ${entry.content}`
          );
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'user_memory_remember',
    {
      title: 'Memory · Act — Remember something about you',
      description:
        'Save a short note to YOUR memory so every chat you have — not just this run — sees ' +
        'it from now on. Use it for durable facts and preferences, never for the current ' +
        'answer. One sentence or two; at most 500 characters.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        note: z.string().min(1).max(500).describe('What to remember.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (!note) return errText('Nothing to remember: `note` is empty.');
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const id = await appendUserMemory(dbResult.val, {
        tenantId: context.tenantId,
        ownerSubject: context.subject,
        content: note,
        chatId: null,
      });
      if (!id) return errText('Could not save the note.');
      return textResult(`Remembered (entryId: ${id}).`);
    }
  );

  server.registerTool(
    'user_memory_forget',
    {
      title: 'Memory · Act — Forget something remembered about you',
      description:
        'Delete named entries (entryIds from user_memory_list) from YOUR memory, or ' +
        'everything with `all: true`. `all: true` needs `confirm: true`; without it you get ' +
        'a count of what would go and nothing is deleted. Memory does not come back.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        entryIds: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .optional()
          .describe('From user_memory_list — the entries to forget'),
        all: z.boolean().optional().describe('Forget everything. Requires confirm: true'),
        confirm: z.boolean().optional().describe('Required for all: true'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const subject = context.subject;
      const all = args.all === true;
      const entryIds = Array.isArray(args.entryIds)
        ? [
            ...new Set(
              args.entryIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
            ),
          ]
        : [];
      if (!all && entryIds.length === 0) {
        return errText('Nothing to forget — pass entryIds (from user_memory_list), or all: true.');
      }
      if (all && entryIds.length > 0) {
        return errText(
          'all: true already clears everything — call it on its own, or name entryIds instead.'
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      if (all) {
        const held = await countUserMemory(db, context.tenantId, subject);
        if (held.entries === 0 && !held.hasSummary) {
          return textResult('Nothing remembered already — nothing to forget.');
        }
        if (args.confirm !== true) {
          return textResult(
            [
              `Would clear ALL of your memory: ${entryCount(held.entries)}${held.hasSummary ? ' and the rolling summary' : ''}.`,
              'Nothing deleted — call again with confirm: true.',
            ].join('\n')
          );
        }
        const deleted = await forgetUserMemory(db, context.tenantId, subject, { kind: 'all' });
        return textResult(`Cleared your memory: ${entryCount(deleted)} forgotten.`);
      }

      const deleted = await forgetUserMemory(db, context.tenantId, subject, {
        kind: 'entries',
        ids: entryIds,
      });
      return deleted > 0
        ? textResult(`${deleted}/${entryIds.length} named entr${entryIds.length === 1 ? 'y' : 'ies'} forgotten.`)
        : errText('None of those entry ids matched anything of yours.');
    }
  );
}
