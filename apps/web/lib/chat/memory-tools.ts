/**
 * project_memory_remember / project_memory_forget — how a chat inside a
 * project leaves notes for the project's other chats. Offered only when
 * the chat is in a project and the org is not read-only; who may write
 * is decided by the project's access (owner, editor, or any member — a
 * member's chat is theirs, and their notes are attributed).
 */

import { appendProjectMemory, forgetProjectMemory, readProjectMemory } from './memory';
import { errorResult, textResult, type LocalTool } from './local-tools';

export function memoryTools(): LocalTool[] {
  return [
    {
      def: {
        name: 'project_memory_remember',
        description:
          "Save a short note to this project's memory so every chat in the project sees it from now on. Use it for durable facts, decisions and preferences — not for the current answer. One sentence or two; at most 500 characters.",
        inputSchema: {
          type: 'object',
          properties: { note: { type: 'string', description: 'What to remember.' } },
          required: ['note'],
        },
      },
      async execute(input, context) {
        if (!context.projectId) return errorResult('This chat is not in a project.');
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const note = typeof input.note === 'string' ? input.note.trim() : '';
        if (!note) return errorResult('Nothing to remember: `note` is empty.');
        const id = await appendProjectMemory(context.db, {
          tenantId: context.tenantId,
          projectId: context.projectId,
          content: note,
          authorSubject: context.subject,
          chatId: context.chatId,
        });
        return id
          ? textResult(`Remembered (memory id ${id}).`)
          : errorResult('Could not save the note.');
      },
    },
    {
      def: {
        name: 'project_memory_forget',
        description:
          "Delete one of this project's memory notes by id (the ids are listed by project_memory_list). Use it when a remembered fact is wrong or no longer true.",
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The memory id to delete.' } },
          required: ['id'],
        },
      },
      async execute(input, context) {
        if (!context.projectId) return errorResult('This chat is not in a project.');
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const id = typeof input.id === 'string' ? input.id : '';
        const deleted = await forgetProjectMemory(context.db, context.tenantId, context.projectId, {
          kind: 'entries',
          ids: [id],
        });
        return deleted > 0 ? textResult('Forgotten.') : errorResult('No memory with that id.');
      },
    },
    {
      def: {
        name: 'project_memory_list',
        description: "List this project's memory notes with their ids and when they were written.",
        inputSchema: { type: 'object', properties: {} },
      },
      async execute(_input, context) {
        if (!context.projectId) return errorResult('This chat is not in a project.');
        const memory = await readProjectMemory(context.db, context.tenantId, context.projectId, {
          maxEntries: 100,
        });
        if (!memory.summary && memory.entries.length === 0)
          return textResult('The project has no memory yet.');
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
