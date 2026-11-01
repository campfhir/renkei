/**
 * What deleting an artifact would touch, and taking a shared one off
 * one's own list, run for real on the memory store (GET …/impact,
 * DELETE …/artifacts/:id). These were artifacts.spec.ts's delete dialog
 * naming the project and the colleague who lose the file, and its
 * "Remove from my artifacts" leaving the owner's file in place; the spec
 * keeps the dialog drawn over a real impact at phone width.
 *
 * The file's key is not what these answers are about, so the key module
 * is replaced: access is decided before any key is opened.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/chat/chat-keys', () => ({
  cipherFor: jest.fn(async () => ({})),
  chatCipherById: jest.fn(async () => ({})),
  projectCipherById: jest.fn(async () => ({})),
  revokeKey: jest.fn(async () => undefined),
}));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { grantResourceAccess } from '@/lib/chat/access';
import { DELETE } from '../route';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const ME = 'owner-subject';
const PRIYA = 'priya-subject';
const SAM = 'sam-subject';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  signedIn(ME);
});

afterEach(() => resetDataStore());

function signedIn(subject: string): void {
  mockGetSession.mockResolvedValue({ subject, roles: ['renkei-user'] });
}

async function upload(owner: string, filename: string, chatId: string | null = null) {
  const id = randomUUID();
  await getDataStore().artifacts.create({
    id,
    ownerSubject: owner,
    chatId,
    messageId: null,
    origin: 'upload',
    keyKind: 'artifact',
    keyRef: null,
    blobKey: `blobs/${id}`,
    filename,
    contentType: 'text/markdown',
    sizeBytes: 10,
    extractedText: null,
    extractStatus: 'done',
    digestStatus: 'done',
  });
  return id;
}

async function share(owner: string, kind: 'artifact' | 'chat_project', id: string, to: string) {
  const outcome = await grantResourceAccess(owner, kind, id, {
    granteeSubject: to,
    role: 'viewer',
    expiresAt: null,
  });
  expect(outcome).toBe('OK');
}

const params = (artifactId: string) => ({ params: Promise.resolve({ artifactId }) });
const request = (method: string) => new NextRequest('http://test.local/x', { method });

async function impactOf(artifactId: string) {
  const response = await GET(request('GET'), params(artifactId));
  return { status: response.status, body: await response.json() };
}

describe('the impact of deleting a file', () => {
  it('names each project that holds it, with its members and mode, and the people it is shared with', async () => {
    const store = getDataStore();
    await store.identities.upsert({
      subject: PRIYA,
      email: 'priya@example.test',
      displayName: 'Priya Friend',
      idpGroups: [],
    });
    const guide = await upload(ME, 'schema-guide.md');
    const projectId = await store.chatProjects.create({
      ownerSubject: ME,
      name: 'Billing API',
      description: null,
      toolConfig: null,
    });
    await share(ME, 'chat_project', projectId, SAM);
    await store.artifacts.addReference({
      artifactId: guide,
      projectId,
      mode: 'always',
      addedBy: ME,
    });
    await share(ME, 'artifact', guide, PRIYA);

    const { status, body } = await impactOf(guide);
    expect(status).toBe(200);
    expect(body.impact).toEqual({
      projects: [{ id: projectId, name: 'Billing API', kind: 'chat', members: 2, mode: 'always' }],
      sharedWith: [{ subject: PRIYA, name: 'Priya Friend', email: 'priya@example.test' }],
      chat: null,
    });
  });

  it('a file nobody else uses has nothing to warn about but the chat it came from', async () => {
    const chatId = await getDataStore().chats.create({
      ownerSubject: ME,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
    const csv = await upload(ME, 'march-invoices.csv', chatId);
    const { body } = await impactOf(csv);
    expect(body.impact).toEqual({
      projects: [],
      sharedWith: [],
      chat: { id: chatId, title: null },
    });
  });

  it('is the owner’s to ask: anyone else, even a person it is shared with, finds no such file', async () => {
    const manual = await upload(PRIYA, 'vendor-sdk-manual.txt');
    await share(PRIYA, 'artifact', manual, ME);
    expect((await impactOf(manual)).status).toBe(404);
    expect((await impactOf(randomUUID())).status).toBe(404);
  });
});

describe('removing a shared file from my artifacts', () => {
  it('takes it off my list and leaves the owner’s file; a second remove finds nothing', async () => {
    const manual = await upload(PRIYA, 'vendor-sdk-manual.txt');
    await share(PRIYA, 'artifact', manual, ME);

    const first = await DELETE(request('DELETE'), params(manual));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, outcome: 'left' });
    expect(await getDataStore().resourceGrants.activeRole('artifact', manual, ME)).toBeNull();
    expect((await getDataStore().artifacts.get(manual))?.ownerSubject).toBe(PRIYA);

    const again = await DELETE(request('DELETE'), params(manual));
    expect(again.status).toBe(404);
  });

  it('someone who only reads it through a project may not delete it', async () => {
    const store = getDataStore();
    const guide = await upload(PRIYA, 'schema-guide.md');
    const projectId = await store.chatProjects.create({
      ownerSubject: PRIYA,
      name: 'Billing API',
      description: null,
      toolConfig: null,
    });
    await share(PRIYA, 'chat_project', projectId, ME);
    await store.artifacts.addReference({
      artifactId: guide,
      projectId,
      mode: 'on_demand',
      addedBy: PRIYA,
    });
    const response = await DELETE(request('DELETE'), params(guide));
    expect(response.status).toBe(403);
    expect(await store.artifacts.get(guide)).not.toBeNull();
  });
});
