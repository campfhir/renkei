/**
 * Importing from another assistant through POST /api/account/import, on
 * the memory store: a preview writes nothing; an import writes memories
 * and chats as the person's own, never pushes out memories they already
 * have, stops cleanly when a chat's key cannot be made, and a Renkei
 * export imports back as it left. What each format parses to is
 * import-parse.test.ts's.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/chat/chat-keys', () => ({
  ...jest.requireActual('@/lib/chat/chat-keys'),
  createKey: (kind: string, resource: { id: string }) =>
    jest.requireActual('@/lib/data-portability/test-keys').testCreateKey(kind, resource),
  wrapKeyUnderProject: jest.fn(),
  cipherFor: (kind: string, resource: { id: string }) =>
    jest.requireActual('@/lib/data-portability/test-keys').testCipherFor(kind, resource),
}));
jest.mock('@renkei/delegate-client', () => ({
  ...jest.requireActual('@renkei/delegate-client'),
  delegateClient: () => jest.requireActual('@/lib/data-portability/test-keys').testPersonSealing,
}));

import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateSettingsCache } from '@renkei/settings';
import { appendUserMemory, readUserMemory, USER_MEMORY_HARD_CAP } from '@/lib/chat/user-memory';
import { cipherFor } from '@/lib/chat/chat-keys';
import { listMessages } from '@/lib/chat/messages';
import { blockChatKeys } from '@/lib/data-portability/test-keys';
import { IMPORT_MEMORY_MAX_CHARS, IMPORT_MAX_MEMORIES } from '@/lib/data-portability/import-parse';
import { GET as exportGET } from '../export/route';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

let me = '';
let n = 0;

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateSettingsCache();
  blockChatKeys(false);
  n += 1;
  me = `importer-${n}`;
  mockGetSession.mockImplementation(async () => ({ subject: me, roles: ['renkei-user'] }));
});

afterEach(() => {
  resetDataStore();
  invalidateSettingsCache();
});

function post(query: string, body: BodyInit): Promise<Response> {
  return POST(
    new NextRequest(`http://test.local/api/account/import?${query}`, { method: 'POST', body })
  );
}

const claudeExport = JSON.stringify([
  {
    name: 'Garden plan',
    created_at: '2026-04-01T10:00:00.000Z',
    chat_messages: [
      { sender: 'human', text: 'When do I plant tomatoes in Denver?' },
      { sender: 'assistant', text: 'After mid-May.' },
    ],
  },
  {
    name: 'Cover letter',
    created_at: '2026-05-01T10:00:00.000Z',
    chat_messages: [{ sender: 'human', text: 'Polish my cover letter' }],
  },
]);

async function chatGptZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'conversations.json',
    JSON.stringify([
      {
        title: 'Marathon training',
        create_time: 1_760_000_000,
        current_node: 'b',
        mapping: {
          a: {
            parent: null,
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Build me a 16-week plan'] },
            },
          },
          b: {
            parent: 'a',
            message: {
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Week 1: easy miles.'] },
            },
          },
        },
      },
    ])
  );
  zip.file('chat.html', '<html></html>');
  zip.file('notes/about-me.md', '- Runs marathons\n- Lives in Denver');
  return zip.generateAsync({ type: 'uint8array' });
}

async function myChats() {
  return getDataStore().chats.listOwned(me, { includeArchived: true, limit: 50 });
}

async function textsOf(chatId: string): Promise<[string, string][]> {
  const cipher = await cipherFor('chat', { id: chatId, ownerSubject: me }, me, 'owner');
  return (await listMessages(chatId, cipher)).map((message) => [
    message.role,
    message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join(''),
  ]);
}

describe('previewing an import', () => {
  it('says what it found and writes nothing', async () => {
    const response = await post('mode=preview&name=conversations.json', claudeExport);
    expect(response.status).toBe(200);
    expect((await response.json()).preview).toEqual({
      sources: ['Claude'],
      memories: 0,
      chats: 2,
      messages: 3,
      sampleMemories: [],
      sampleChats: [
        { title: 'Cover letter', messages: 1 },
        { title: 'Garden plan', messages: 2 },
      ],
      notes: [],
    });
    expect(await myChats()).toEqual([]);
  });

  it('refuses a file with nothing in it it can use, saying why', async () => {
    const response = await post('mode=preview&name=x.json', '{"nothing": true}');
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('Not recognised, left out: x.json.');
  });

  it('refuses a zip it cannot open, and an empty body', async () => {
    expect((await post('mode=preview&name=a.zip', 'PK\u0003\u0004garbage')).status).toBe(400);
    expect((await post('mode=preview&name=a.md', '')).status).toBe(400);
  });

  it('refuses without a mode, and when signed out', async () => {
    expect((await post('name=a.md', '- x')).status).toBe(400);
    mockGetSession.mockResolvedValueOnce(null);
    expect((await post('mode=preview&name=a.md', '- x')).status).toBe(401);
  });
});

describe('importing', () => {
  it('writes the memories and the chats from a ChatGPT zip as the person’s own', async () => {
    const response = await post(
      'mode=import&name=export.zip&memories=1&chats=1',
      Buffer.from(await chatGptZip())
    );
    expect(response.status).toBe(200);
    expect((await response.json()).imported).toEqual({
      memoriesAdded: 2,
      memoriesNoRoom: 0,
      chatsAdded: 1,
      messagesAdded: 2,
      stopped: null,
    });

    const memory = await readUserMemory(me, { maxEntries: 10 });
    // Appended within one millisecond here, so their order is a tie: compare as a set.
    expect(memory.entries.map((entry) => entry.content).sort()).toEqual([
      'Lives in Denver',
      'Runs marathons',
    ]);

    const [chat] = await myChats();
    expect(chat).toMatchObject({
      title: 'Marathon training · ChatGPT',
      archivedAt: null,
      projectId: null,
    });
    expect(chat.lastMessageAt).not.toBeNull();
    expect(await textsOf(chat.id)).toEqual([
      ['user', 'Build me a 16-week plan'],
      ['assistant', 'Week 1: easy miles.'],
    ]);
    expect(mockAudit).toHaveBeenCalledWith({
      actorSubject: me,
      action: 'user.data_imported',
      details: {
        sources: ['chatgpt', 'markdown'],
        memories: 2,
        chats: 1,
        messages: 2,
        stopped: null,
      },
    });
  });

  it('writes only what was chosen, and archives the chats when asked', async () => {
    const response = await post('mode=import&name=c.json&chats=1&archive=1', claudeExport);
    expect((await response.json()).imported.chatsAdded).toBe(2);
    const chats = await myChats();
    expect(chats.map((chat) => chat.title).sort()).toEqual([
      'Cover letter · Claude',
      'Garden plan · Claude',
    ]);
    expect(chats.every((chat) => chat.archivedAt !== null)).toBe(true);
    expect((await readUserMemory(me)).entries).toEqual([]);
  });

  it('refuses an import that chooses nothing', async () => {
    expect((await post('mode=import&name=c.json', claudeExport)).status).toBe(400);
  });

  it('never pushes out memories the person already has: it adds what fits and says how many did not', async () => {
    for (let i = 0; i < USER_MEMORY_HARD_CAP - 1; i += 1) {
      await appendUserMemory({ ownerSubject: me, content: `existing ${i}`, chatId: null });
    }
    const response = await post(
      'mode=import&name=m.md&memories=1',
      '- new one\n- new two\n- new three'
    );
    expect((await response.json()).imported).toMatchObject({ memoriesAdded: 1, memoriesNoRoom: 2 });
    const memory = await readUserMemory(me, { maxEntries: USER_MEMORY_HARD_CAP });
    expect(memory.entries).toHaveLength(USER_MEMORY_HARD_CAP);
    expect(memory.entries.map((entry) => entry.content)).toContain('existing 0');
    expect(memory.entries.map((entry) => entry.content)).toContain('new one');
    expect(memory.entries.map((entry) => entry.content)).not.toContain('new two');
  });

  it('stops when a chat’s key cannot be made, leaving no half-made chat behind', async () => {
    blockChatKeys(true);
    const response = await post('mode=import&name=c.json&memories=1&chats=1', claudeExport);
    expect((await response.json()).imported).toMatchObject({ chatsAdded: 0, stopped: 'chat-key' });
    expect(await myChats()).toEqual([]);
  });
});

describe('a Renkei export imported again', () => {
  it('brings back the memories and the chats it left with', async () => {
    await post('mode=import&name=c.json&chats=1', claudeExport);
    await post('mode=import&name=m.md&memories=1', '- Prefers metric units\n- Has two cats');
    const exported = await exportGET(new NextRequest('http://test.local/api/account/export'));
    expect(exported.status).toBe(200);
    const zipBytes = Buffer.from(await exported.arrayBuffer());

    me = `${me}-elsewhere`;
    const response = await post('mode=import&name=renkei-export.zip&memories=1&chats=1', zipBytes);
    expect((await response.json()).imported).toMatchObject({ memoriesAdded: 2, chatsAdded: 2 });
    expect((await readUserMemory(me)).entries.map((entry) => entry.content).sort()).toEqual([
      'Has two cats',
      'Prefers metric units',
    ]);
    const chats = await myChats();
    // A Renkei chat keeps its title as it was: no second "· Claude".
    expect(chats.map((chat) => chat.title).sort()).toEqual([
      'Cover letter · Claude',
      'Garden plan · Claude',
    ]);
    const garden = chats.find((chat) => chat.title === 'Garden plan · Claude')!;
    expect(await textsOf(garden.id)).toEqual([
      ['user', 'When do I plant tomatoes in Denver?'],
      ['assistant', 'After mid-May.'],
    ]);
  });
});

describe('the parser’s limits match memory’s', () => {
  it('splits and caps memories exactly as memory stores them', () => {
    expect(IMPORT_MEMORY_MAX_CHARS).toBe(
      jest.requireActual('@/lib/chat/user-memory').USER_MEMORY_ENTRY_MAX_CHARS
    );
    expect(IMPORT_MAX_MEMORIES).toBe(USER_MEMORY_HARD_CAP);
  });
});
