/**
 * Downloading your own data through GET /api/account/export (the zip) and
 * GET /api/account/export/profile (the portable Markdown), on the memory
 * store, with chats written the way the app writes them: everything of
 * yours comes out — archived chats, preferences, memory, projects — and
 * nothing of anyone else's. What each file holds is export-bundle.test.ts's.
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
import { createChat, updateChat } from '@/lib/chat/store';
import { cipherFor } from '@/lib/chat/chat-keys';
import { insertMessage } from '@/lib/chat/messages';
import { createProject } from '@/lib/chat/projects';
import { appendUserMemory } from '@/lib/chat/user-memory';
import { GET } from './route';
import { GET as profileGET } from './profile/route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

let n = 0;
let me = '';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  n += 1;
  me = `exporter-${n}`;
  mockGetSession.mockImplementation(async () => ({ subject: me, roles: ['renkei-user'] }));
});

afterEach(() => resetDataStore());

async function chatWith(owner: string, title: string, turns: [string, string]): Promise<string> {
  const chatId = await createChat({
    ownerSubject: owner,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
  });
  const cipher = await cipherFor('chat', { id: chatId, ownerSubject: owner }, owner, 'owner');
  const [prompt, reply] = turns;
  await insertMessage({
    chatId,
    turnId: null,
    role: 'user',
    kind: 'prompt',
    status: 'complete',
    blocks: [{ type: 'text', text: prompt }],
    cipher,
  });
  await insertMessage({
    chatId,
    turnId: null,
    role: 'assistant',
    kind: 'assistant',
    status: 'complete',
    blocks: [{ type: 'text', text: reply }],
    cipher,
  });
  await getDataStore().chats.touch(chatId, { titleIfMissing: title });
  return chatId;
}

async function unzip(response: Response): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const files = new Map<string, string>();
  for (const file of Object.values(zip.files)) {
    if (!file.dir) files.set(file.name, await file.async('string'));
  }
  return files;
}

describe('the data export zip', () => {
  it('comes as a zip named for the day, never cached', async () => {
    const response = await GET(new NextRequest('http://test.local/api/account/export'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="renkei-export-\d{4}-\d{2}-\d{2}\.zip"/
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('holds every chat of yours, archived ones too, opened — and none of anyone else’s', async () => {
    const kept = await chatWith(me, 'Budget', ['Review my budget', 'Rent is high.']);
    const archived = await chatWith(me, 'Old trip', ['Plan Lisbon', 'Alfama first.']);
    await updateChat(me, archived, { archived: true });
    await chatWith('someone-else', 'Not mine', ['secret', 'secret reply']);

    const files = await unzip(await GET(new NextRequest('http://test.local/api/account/export')));
    const index: { id: string; title: string; archived: boolean; json: string }[] = JSON.parse(
      files.get('chats/index.json')!
    );
    expect(index.map((line) => [line.id, line.title, line.archived]).sort()).toEqual(
      [
        [kept, 'Budget', false],
        [archived, 'Old trip', true],
      ].sort()
    );
    const budget = JSON.parse(files.get(index.find((line) => line.id === kept)!.json)!);
    expect(budget.messages.map((m: { blocks: { text: string }[] }) => m.blocks[0].text)).toEqual([
      'Review my budget',
      'Rent is high.',
    ]);
    expect([...files.values()].some((text) => text.includes('secret'))).toBe(false);
  });

  it('holds your preferences, memory and projects', async () => {
    await getDataStore().userPreferences.set(me, 'theme', { mode: 'dark' });
    await getDataStore().userPreferences.set('someone-else', 'theme', { mode: 'light' });
    await appendUserMemory({ ownerSubject: me, content: 'Vegetarian', chatId: null });
    await createProject({
      ownerSubject: me,
      name: 'Hiring',
      description: 'Roles',
      instructions: 'Be formal.',
      toolConfig: null,
    });

    const files = await unzip(await GET(new NextRequest('http://test.local/api/account/export')));
    expect(JSON.parse(files.get('preferences.json')!)).toEqual({ theme: { mode: 'dark' } });
    expect(
      JSON.parse(files.get('memory.json')!).entries.map((e: { content: string }) => e.content)
    ).toEqual(['Vegetarian']);
    expect(JSON.parse(files.get('projects.json')!)).toMatchObject([
      { name: 'Hiring', description: 'Roles', instructions: 'Be formal.' },
    ]);
    expect(files.get('profile.md')).toContain('- Vegetarian');
  });

  it('is audited with counts, never content', async () => {
    await chatWith(me, 'Budget', ['Review my budget', 'Rent is high.']);
    await GET(new NextRequest('http://test.local/api/account/export'));
    expect(mockAudit).toHaveBeenCalledWith({
      actorSubject: me,
      action: 'user.data_exported',
      details: { format: 'zip', chats: 1, memoryEntries: 0, projects: 0 },
    });
  });

  it('is refused when signed out', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest('http://test.local/api/account/export'))).status).toBe(401);
  });
});

describe('the portable profile', () => {
  it('comes as Markdown with your memory and what you asked', async () => {
    await getDataStore().identities.upsert({
      subject: me,
      email: `${me}@example.com`,
      displayName: 'Sam Rivera',
      idpGroups: [],
    });
    await appendUserMemory({ ownerSubject: me, content: 'Works nights', chatId: null });
    await chatWith(me, 'Budget', ['Review my budget', 'Rent is high.']);

    const response = await profileGET(
      new NextRequest('http://test.local/api/account/export/profile')
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/filename="renkei-profile-/);
    const text = await response.text();
    expect(text).toContain('# About Sam Rivera');
    expect(text).toContain('- Works nights');
    expect(text).toContain('- I asked: Review my budget');
    expect(text).not.toContain('Rent is high.');
  });
});
