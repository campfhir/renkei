/**
 * user_memory_list — reads the same `chat_user_memories` a chat's own
 * chat_memory_remember/forget/list write and read (apps/web/lib/chat/
 * user-memory-tools.ts), reachable from the general MCP surface so an
 * agent run can see what a person's chats remember about them too.
 * Deliberately READ-ONLY: an agent run may not remember or forget on the
 * person's behalf — only the chat itself (chat_memory_remember/forget)
 * and the person's own Memory page write these rows. Owner-scoped
 * exactly like cards (`../cards`): `context.subject` IS the key, no
 * agent-access-grant indirection, because there is no sharing concept
 * for a person's own memory — for an agent run, `context.subject`
 * already names the run's owner (common.ts), so this needs no extra
 * plumbing to reach the right rows.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import { readUserMemory } from '@/lib/chat/user-memory';

/** The connector key the memory capabilities register under. */
export const USER_MEMORY_CONNECTOR = 'user-memory';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const NO_SUBJECT = 'This caller has no recorded identity, so it cannot own memory.';

export function registerUserMemoryTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'user_memory_list',
    {
      title: 'Memory · Read — What is remembered about you',
      description:
        'List what YOUR chats have remembered about you across every chat you own — the ' +
        'rolling summary and every entry, newest first. A project keeps separate memory of ' +
        'its own, not included here. Read-only: an agent run cannot add to or remove this ' +
        "memory, only the person's own chats or their Memory page can.",
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
          lines.push(`- [${entry.createdAt.toISOString()}] ${entry.content}`);
        }
      }
      return textResult(lines.join('\n'));
    }
  );
}
