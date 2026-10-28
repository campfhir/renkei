import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function event(n: number, subject: string, minute: number) {
  return {
    id: id(n),
    subject,
    connector: 'mirth',
    action: 'read',
    tool_name: 'mirth_get_message',
    channel_id: 'ch',
    message_id: String(n),
    created_at: at(minute),
  };
}

const fixture = {
  phi_access_events: [
    event(1, 'ann', 1),
    event(2, 'bob', 2),
    event(3, 'ann', 3),
    event(4, 'ann', 3),
    event(5, 'ann', 5),
  ],
};

export const phiAccessScenarios: Scenario<DataStore>[] = [
  {
    method: 'phiAccess.list',
    name: 'newest first, ties by id descending; by subject, before and limit',
    fixture,
    run: async (store) => [
      (await store.phiAccess.list({ limit: 10 })).map((e) => e.id),
      await store.phiAccess.list({ subject: 'ann', limit: 2 }),
      (await store.phiAccess.list({ subject: 'ann', limit: 10, before: at(3) })).map((e) => e.id),
      await store.phiAccess.list({ subject: 'nobody', limit: 10 }),
    ],
  },
  {
    method: 'phiAccess.record',
    name: 'appended and listed, with the generated id and time left out',
    fixture,
    run: async (store) => {
      await store.phiAccess.record({
        subject: 'cy',
        agentId: null,
        runId: null,
        connector: 'fileshare',
        instanceId: id(9),
        action: 'download',
        toolName: 'fileshare_read_file',
        channelId: null,
        messageId: null,
        documentId: null,
        pathHash: 'ab'.repeat(32),
      });
      const rows = await store.phiAccess.list({ subject: 'cy', limit: 10 });
      return { rows: rows.map(({ id: _id, createdAt: _at, ...rest }) => rest) };
    },
  },
];
