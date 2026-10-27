import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { UploadSlotRecord } from './types';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FUTURE = new Date(Date.UTC(2099, 0, 1));
const PAST = new Date(Date.UTC(2001, 0, 1));
const CREATED = new Date(Date.UTC(2026, 0, 1));

const SLOT = { open: uid(1), expired: uid(2), done: uid(3), bobs: uid(4) };

function slot(id: string, subject: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    token_hash: `hash-${id}`,
    subject,
    account_id: `acct-${subject}`,
    kind: 'jira-attachment',
    destination: JSON.stringify({ issueKey: 'ABC-1', nested: { n: 1 } }),
    filename: 'report.pdf',
    content_type: 'application/pdf',
    max_bytes: 1000,
    expires_at: FUTURE,
    created_at: CREATED,
    ...extra,
  };
}

const fixture = {
  upload_slots: [
    slot(SLOT.open, 'ann'),
    slot(SLOT.expired, 'ann', { expires_at: PAST }),
    slot(SLOT.done, 'ann', { status: 'completed', result: 'sent', completed_at: CREATED }),
    slot(SLOT.bobs, 'bob', { content_type: null }),
  ],
};

/** completed_at is the claim's now(): only whether it is set is compared. */
const settled = (record: UploadSlotRecord | null) =>
  record ? { ...record, completedAt: record.completedAt !== null } : null;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

export const uploadSlotScenarios: Scenario<DataStore>[] = [
  {
    method: 'uploadSlots.get',
    name: 'whole record without the hash; missing',
    fixture,
    run: async (store) => [
      await store.uploadSlots.get(SLOT.open),
      await store.uploadSlots.get(SLOT.bobs),
      await store.uploadSlots.get(uid(99)),
    ],
  },
  {
    method: 'uploadSlots.create',
    name: 'inserted pending; a duplicate hash refused',
    run: async (store) => {
      const input = {
        id: SLOT.open,
        tokenHash: 'h1',
        subject: 'ann',
        accountId: 'acct',
        kind: 'fileshare-file',
        destination: { shareId: 's', path: '/' },
        filename: 'a.txt',
        contentType: null,
        maxBytes: 5,
        expiresAt: FUTURE,
      };
      await store.uploadSlots.create(input);
      const created = await store.uploadSlots.get(SLOT.open);
      const duplicate = await store.uploadSlots
        .create({ ...input, id: SLOT.done })
        .then(() => 'ok')
        .catch((error: { code?: string }) => error.code ?? 'error');
      return [created ? { ...created, createdAt: null } : null, duplicate];
    },
  },
  {
    method: 'uploadSlots.claim',
    name: 'by hash or owner, once; wrong proof, expired and used refused',
    fixture,
    run: async (store) => [
      settled(await store.uploadSlots.claim(SLOT.open, { tokenHash: 'wrong' })),
      settled(await store.uploadSlots.claim(SLOT.open, { subject: 'bob' })),
      settled(await store.uploadSlots.claim(SLOT.open, { tokenHash: `hash-${SLOT.open}` })),
      settled(await store.uploadSlots.claim(SLOT.open, { tokenHash: `hash-${SLOT.open}` })),
      settled(await store.uploadSlots.claim(SLOT.expired, { subject: 'ann' })),
      settled(await store.uploadSlots.claim(SLOT.done, { subject: 'ann' })),
      settled(await store.uploadSlots.claim(SLOT.bobs, { subject: 'bob' })),
      settled(await store.uploadSlots.claim(uid(99), { subject: 'ann' })),
      settled(await store.uploadSlots.get(SLOT.expired)),
    ],
  },
  {
    method: 'uploadSlots.finish',
    name: 'completed or failed with the detail; others untouched',
    fixture,
    run: async (store) => {
      await store.uploadSlots.finish(SLOT.open, { ok: false, detail: 'too big' });
      await store.uploadSlots.finish(SLOT.bobs, { ok: true, detail: 'Wrote it.' });
      return [
        settled(await store.uploadSlots.get(SLOT.open)),
        settled(await store.uploadSlots.get(SLOT.bobs)),
        settled(await store.uploadSlots.get(SLOT.expired)),
      ];
    },
  },
  {
    method: 'uploadSlots.setDestination',
    name: 'replaced as JSON; others untouched',
    fixture,
    run: async (store) => {
      await store.uploadSlots.setDestination(SLOT.open, { onbaseUploadId: 'x', list: [1, 'a'] });
      return [
        (await store.uploadSlots.get(SLOT.open))?.destination,
        (await store.uploadSlots.get(SLOT.bobs))?.destination,
      ];
    },
  },
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
      const read = await store.uploadSlots.get(id(7));
      return { again, read: read ? { ...read, createdAt: null } : null };
    },
  },
  {
    method: 'uploadSlots.expireStale',
    name: 'pending past expiry turn expired; live, settled and others untouched',
    fixture,
    run: async (store) => {
      const count = await store.uploadSlots.expireStale();
      const again = await store.uploadSlots.expireStale();
      const statuses = [];
      for (const slotId of [SLOT.open, SLOT.expired, SLOT.done, SLOT.bobs]) {
        statuses.push((await store.uploadSlots.get(slotId))?.status);
      }
      return { count, again, statuses };
    },
  },
  {
    method: 'uploadSlots.pruneSettled',
    name: 'old terminal slots go, oldest first up to the limit; pending and recent stay',
    fixture: {
      upload_slots: [
        slot(uid(11), 'ann', { status: 'completed', created_at: PAST }),
        slot(uid(12), 'ann', { status: 'failed', created_at: PAST }),
        slot(uid(13), 'bob', { status: 'expired', created_at: new Date(Date.UTC(2002, 0, 1)) }),
        slot(uid(14), 'bob', { status: 'pending', created_at: PAST }),
        slot(uid(15), 'bob', { status: 'completed', created_at: FUTURE }),
      ],
    },
    run: async (store) => {
      const first = await store.uploadSlots.pruneSettled(1, 1);
      const present = async () => {
        const out: string[] = [];
        for (const n of [11, 12, 13, 14, 15]) {
          if (await store.uploadSlots.get(uid(n))) out.push(uid(n));
        }
        return out;
      };
      const afterFirst = await present();
      const rest = await store.uploadSlots.pruneSettled(1, 10);
      return { first, afterFirst, rest, afterAll: await present() };
    },
  },
];
