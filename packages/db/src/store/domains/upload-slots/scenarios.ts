import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function slot(n: number, subject: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    token_hash: `h${n}`,
    subject,
    account_id: 'acct',
    kind: 'onbase-document',
    destination: JSON.stringify({ onbaseUploadId: `u${n}` }),
    filename: `f${n}.pdf`,
    max_bytes: 1000,
    expires_at: at(30),
    ...extra,
  };
}

const fixture = {
  upload_slots: [
    slot(1, 'ann'),
    slot(2, 'bob'),
    slot(3, 'ann', { expires_at: at(5) }),
    slot(4, 'ann', { status: 'failed', result: 'too big', completed_at: at(2) }),
  ],
};

export const uploadSlotScenarios: Scenario<DataStore>[] = [
  {
    method: 'uploadSlots.get',
    name: 'by id whoever owns it; unknown and malformed ids',
    fixture,
    run: async (store) => [
      await store.uploadSlots.get(id(1)),
      await store.uploadSlots.get(id(4)),
      await store.uploadSlots.get(id(9)),
      await store.uploadSlots.get('nope').then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      ),
    ],
  },
  {
    method: 'uploadSlots.claimPendingByOwner',
    name: 'own pending unexpired slot once; others refused',
    fixture,
    run: async (store) => [
      await store.uploadSlots.claimPendingByOwner(id(1), 'ann', at(10)),
      await store.uploadSlots.claimPendingByOwner(id(1), 'ann', at(10)),
      await store.uploadSlots.claimPendingByOwner(id(2), 'ann', at(10)),
      await store.uploadSlots.claimPendingByOwner(id(3), 'ann', at(10)),
      await store.uploadSlots.claimPendingByOwner(id(4), 'ann', at(10)),
      (await store.uploadSlots.get(id(2)))?.status ?? null,
    ],
  },
  {
    method: 'uploadSlots.create',
    name: 'pending after; a reused id is refused',
    fixture,
    run: async (store) => {
      const fresh = {
        id: id(7),
        tokenHash: 'h7',
        subject: 'cy',
        accountId: 'acct-c',
        kind: 'jira-attachment',
        destination: { issueKey: 'PROJ-1' },
        filename: 'a.txt',
        contentType: 'text/plain',
        maxBytes: 20,
        expiresAt: at(15),
      };
      await store.uploadSlots.create(fresh);
      const again = await store.uploadSlots.create(fresh).then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      );
      return { again, read: await store.uploadSlots.get(id(7)) };
    },
  },
];
