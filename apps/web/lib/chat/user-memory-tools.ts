/**
 * chat_memory_remember / chat_memory_forget / chat_memory_list — a
 * person's own memory, carried across every chat they own. Offered only
 * outside a project (a project chat writes the project's memory instead,
 * via memory-tools.ts, which every other member of the project also
 * reads) and only when the org is not read-only.
 */

import { appendUserMemory, forgetUserMemory, readUserMemory } from './user-memory';
import { errorResult, textResult, type LocalTool } from './local-tools';

export function userMemoryTools(): LocalTool[] {
  return [
    {
      def: {
        name: 'chat_memory_remember',
        description:
          'Save a short note to memory so every chat you have with this person sees it from now on — not just this one. Use it for durable facts, preferences and context about them, never for the current answer. One sentence or two; at most 500 characters.',
        inputSchema: {
          type: 'object',
          properties: { note: { type: 'string', description: 'What to remember.' } },
          required: ['note'],
        },
      },
      async execute(input, context) {
        if (context.projectId) return errorResult('This chat is in a project; use project_memory_remember.');
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const note = typeof input.note === 'string' ? input.note.trim() : '';
        if (!note) return errorResult('Nothing to remember: `note` is empty.');
        const id = await appendUserMemory(context.db, {
          tenantId: context.tenantId,
          ownerSubject: context.subject,
          content: note,
          chatId: context.chatId,
        });
        return id
          ? textResult(`Remembered (memory id ${id}).`)
          : errorResult('Could not save the note.');
      },
    },
    {
      def: {
        name: 'chat_memory_forget',
        description:
          'Delete one of your memory notes by id (the ids are listed by chat_memory_list). Use it when a remembered fact is wrong or no longer true.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The memory id to delete.' } },
          required: ['id'],
        },
      },
      async execute(input, context) {
        if (context.projectId) return errorResult('This chat is in a project; use project_memory_forget.');
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const id = typeof input.id === 'string' ? input.id : '';
        const deleted = await forgetUserMemory(context.db, context.tenantId, context.subject, {
          kind: 'entries',
          ids: [id],
        });
        return deleted > 0 ? textResult('Forgotten.') : errorResult('No memory with that id.');
      },
    },
    {
      def: {
        name: 'chat_memory_list',
        description: 'List your memory notes with their ids and when they were written.',
        inputSchema: { type: 'object', properties: {} },
      },
      readOnly: true,
      async execute(_input, context) {
        if (context.projectId) return errorResult('This chat is in a project; use project_memory_list.');
        const memory = await readUserMemory(context.db, context.tenantId, context.subject, {
          maxEntries: 100,
        });
        if (!memory.summary && memory.entries.length === 0)
          return textResult('No memory saved yet.');
        const lines = [
          ...(memory.summary ? [`Summary: ${memory.summary}`] : []),
          ...memory.entries.map(
            (entry) =>
              `- ${entry.id} [${entry.createdAt.toISOString().slice(0, 10)}] ${entry.content}`
          ),
        ];
        return textResult(lines.join('\n'));
      },
    },
  ];
}
