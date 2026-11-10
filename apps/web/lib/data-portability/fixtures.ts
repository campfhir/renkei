/** One person's data, small but with every kind of part, for the data-portability tests. */

import type { ExportData } from './types';

export function sample(): ExportData {
  return {
    exportedAt: '2026-11-06T12:00:00.000Z',
    person: { subject: 'sam', displayName: 'Sam Rivera', email: 'sam@example.com' },
    preferences: [{ key: 'theme', value: { mode: 'dark' } }],
    memory: {
      summary: 'Sam is a nurse manager.',
      entries: [
        {
          id: 'm2',
          content: 'Lives in Denver',
          chatId: null,
          createdAt: '2026-10-02T00:00:00.000Z',
        },
        {
          id: 'm1',
          content: 'Prefers short answers',
          chatId: null,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
    projects: [],
    chats: [
      {
        id: '11111111-2222-3333-4444-555555555555',
        title: 'Budget review',
        projectId: null,
        projectName: null,
        archived: false,
        temporary: false,
        keyUnavailable: false,
        createdAt: '2026-10-05T09:00:00.000Z',
        updatedAt: '2026-10-05T09:10:00.000Z',
        summary: null,
        messages: [
          {
            id: 'a',
            role: 'user',
            kind: 'prompt',
            status: 'complete',
            model: null,
            createdAt: '2026-10-05T09:00:00.000Z',
            blocks: [{ type: 'text', text: 'Review my budget' }],
            attachments: [],
          },
          {
            id: 'b',
            role: 'assistant',
            kind: 'assistant',
            status: 'complete',
            model: 'stub',
            createdAt: '2026-10-05T09:00:01.000Z',
            blocks: [{ type: 'tool_use', id: 't1', name: 'read_sheet', input: {} }],
            attachments: [],
          },
          {
            id: 'c',
            role: 'user',
            kind: 'tool_results',
            status: 'complete',
            model: null,
            createdAt: '2026-10-05T09:00:02.000Z',
            blocks: [{ type: 'tool_result', toolUseId: 't1', content: 'rent: 2000' }],
            attachments: [],
          },
          {
            id: 'd',
            role: 'assistant',
            kind: 'assistant',
            status: 'complete',
            model: 'stub',
            createdAt: '2026-10-05T09:00:03.000Z',
            blocks: [{ type: 'text', text: 'Rent is 40% of income.' }],
            attachments: [],
          },
        ],
      },
    ],
  };
}
